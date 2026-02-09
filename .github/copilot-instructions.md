---
applyTo: '**'
---

# Moltbot — Development Guidelines

## TDD: Test-Driven Development

HearthMinds follows strict TDD methodology: **tests before code, always**.

### The Cycle
1. **Red** — Write a failing test that defines expected behavior
2. **Green** — Write minimal code to make the test pass
3. **Refactor** — Clean up while keeping tests green

### Principles
- **Fail hard, fail fast** — Tests should be strict and fail loudly
- **Tests are documentation** — They define expected behavior
- **No code without a test** — If it's not tested, it doesn't work
- **One assertion per test** — Keep tests focused and readable

### When Tests Fail
A failing test is information. Before "fixing" it:
1. Understand WHY it fails
2. Determine if the test or the code is wrong
3. Fix the root cause, not the symptom

## HearthMinds Code Conventions

### General
- **Clarity over cleverness** — Write code that future-you can understand
- **Explicit over implicit** — Make dependencies and assumptions visible
- **Small functions** — Each function does one thing well
- **Meaningful names** — Variables and functions describe their purpose

### Python
- Type hints required for function signatures
- Docstrings for public functions
- `black` for formatting, `ruff` for linting
- Prefer `pathlib` over string path manipulation

### SQL
- Uppercase keywords: `SELECT`, `FROM`, `WHERE`
- Lowercase identifiers: `agent_roles`, `knowledge_modules`
- Always include migration rollback scripts
- Explicit column lists (no `SELECT *` in production code)

### Git
- Conventional commits: `feat:`, `fix:`, `refactor:`, `docs:`, `test:`
- One logical change per commit
- Write commit messages for someone who doesn't have your context

## Git Workflow

### Branches
- `main` — Production-ready code, always deployable
- Feature branches: `feat/short-description`
- Fix branches: `fix/issue-description`

### Commit Messages
Format: `<type>: <short description>`

Types:
- `feat:` — New feature
- `fix:` — Bug fix
- `refactor:` — Code change that neither fixes nor adds
- `docs:` — Documentation only
- `test:` — Adding or updating tests
- `chore:` — Maintenance tasks

### Pull Request Flow
1. Create branch from `main`
2. Make changes with atomic commits
3. Ensure tests pass locally
4. Push and create PR
5. Address review feedback
6. Squash merge to `main`

### Rules
- Never force-push to `main`
- Rebase feature branches on `main` before merging
- Delete branches after merge

## Cross-Repo Generation

All knowledge management runs from hearthminds-org. Generated artifacts are committed to each repo so they work standalone.

### Hub-and-Spoke Model

```
hearthminds-org (hub)
├── knowledge_modules table (source of truth)
├── generate_agent_docs.py (generator)
├── → .github/copilot-instructions.md  (org)
├── → ~/hearthminds-hindsight/.github/copilot-instructions.md
└── → ~/hearthminds-moltbot/.github/copilot-instructions.md
```

### Tag-Based Filtering

Modules are included in a repo's output based on tags:

| Tag | Behavior |
|-----|----------|
| (none / `is_universal=true`) | Included in **all** repos |
| `hindsight` | Included in hindsight output only |
| `moltbot` | Included in moltbot output only |
| `hearthminds-core` | Included in org output only |
| `copilot-instructions` | Included in default (no-repo) output |

### CLI Usage

```bash
# Generate for a specific repo
python scripts/generate_agent_docs.py --copilot-instructions --repo hindsight

# Generate for all repos at once
python scripts/generate_agent_docs.py --copilot-instructions --all-repos

# Generate only for default (hearthminds-org)
python scripts/generate_agent_docs.py --copilot-instructions
```

### REPO_CONFIG

The generator uses a `REPO_CONFIG` dictionary mapping repo tags to output paths:

```python
REPO_CONFIG = {
    "hearthminds-org": {"title": "HearthMinds", "output_base": "."},
    "hindsight":       {"title": "Hindsight",   "output_base": "~/hearthminds-hindsight"},
    "moltbot":         {"title": "Moltbot",     "output_base": "~/hearthminds-moltbot"},
}
```

### Key Principle

Each repo's `git clone` produces a working context — generated files are committed artifacts, not live-synced. The hub (hearthminds-org) is the only place that writes to other repos' working trees.

*Source: F-013 Knowledge Pipeline Hardening, Phase 2*


## Doc Pipeline Commit Discipline

Only the documentation agent commits generated context files. This is a pipeline rule, not a suggestion.

### The Rule

The documentation agent owns the generate → commit cycle for:
- `.github/copilot-instructions.md` (all repos)
- `.github/agents/*.agent.md` (hearthminds-org)
- `docs/generated/*.md` (hearthminds-org)

Other agents (architecture, database, testing, etc.) **propose** module content. The documentation agent reviews, inserts, regenerates, and commits.

### Why

This prevents three failure modes:
1. **Direct editing** — Generated files edited by hand, bypassing the database (source of truth drift)
2. **Conflicting regeneration** — Multiple agents running `generate_agent_docs.py` and committing different outputs
3. **Context drift** — Database state and committed files get out of sync

### The Workflow

```
Any agent: writes pattern/content → docs/modules/my-pattern.md
Documentation agent: reviews → insert_module.py → generate_agent_docs.py → commit
```

### When to Regenerate

After any session that modifies:
- Knowledge modules (insert, update, delete)
- Agent roles (new role, changed description)
- Role-module mappings (role_modules table)

### Exception

Database agents may create migration files, scripts, and test files — these are source artifacts, not generated outputs. The commit discipline applies only to **generated** documentation files.

*Source: F-013 Knowledge Pipeline Hardening*


## Fail Hard Configuration

Silent environment variable defaults violate "fail hard, fail fast." Hardcode at build time.

**Tags:** `hearthminds-core`

### The Problem

Runtime configurability via `os.environ.get()` with defaults makes failures non-deterministic.

```python
# ✗ Anti-pattern: Silent fallback
max_tokens = int(os.environ.get("MAX_TOKENS", "65000"))
# If 65000 is wrong, fails mysteriously at runtime
# Different behavior depending on environment
```

### The Pattern

Hardcode known-good values at build time. Fail fast if assumptions are wrong.

```dockerfile
# ✓ Pattern: Build-time configuration with verification
RUN grep -q 'max_completion_tokens=65000' "$FILE" || exit 1  # Fail if upstream changed
RUN sed -i 's/65000/16000/' "$FILE"                          # Apply known-good value
```

### Why This Matters

- **TDD principle**: Tests should fail loudly, not pass silently with wrong values
- **Reproducibility**: Same image = same behavior everywhere
- **Debugging**: Build fails immediately vs runtime mystery

### When Runtime Config Is Appropriate

Runtime configuration is fine for:
- User-facing settings (ports, log levels)
- Environment-specific values (database URLs)
- Values explicitly designed to vary

Runtime config is **not** appropriate for:
- Internal implementation details
- Values that must match upstream code
- Settings where wrong value = silent corruption

*Source: F-009 Hindsight Import Execution (max_tokens debugging)*


## Knowledge Module Workflow

How to add patterns and knowledge to the modular documentation system.

### The Pipeline

```
docs/modules/*.md → insert_module.py → knowledge_modules table → generate_agent_docs.py → repo files
```

Generated outputs:
- `.github/copilot-instructions.md` (all repos via `--all-repos`)
- `.github/agents/*.agent.md` (hearthminds-org)
- `docs/generated/*.md` (hearthminds-org)

### Step 1: Create Module File

Create a markdown file in `docs/modules/`:

```markdown
## Module Title

Brief description of the pattern.

### When to Use
- Condition 1

### The Pattern
\`\`\`python
# Code example
\`\`\`

### Why
Explanation of rationale.

*Source: F-XXX spec name*
```

**Critical:** Content MUST start with `## Title` — this becomes the section header in generated docs.

### Step 2: Insert into Database

```bash
python scripts/insert_module.py \
  --slug my-pattern-name \
  --title "My Pattern Name" \
  --category patterns \
  --tags hearthminds-core \
  --file docs/modules/my-pattern-name.md \
  --upsert
```

| Argument | Purpose |
|----------|---------|
| `--slug` | Unique kebab-case identifier |
| `--title` | Human-readable name |
| `--category` | Grouping: `patterns`, `workflow`, `architecture`, `methodology`, `identity`, `conventions`, `devops` |
| `--tags` | Comma-separated: `hearthminds-core`, `hindsight`, `moltbot`, `copilot-instructions` |
| `--file` | Path to markdown content |
| `--upsert` | Update if exists (safe to re-run) |
| `--universal` | Include in all agent roles |

### Step 3: Regenerate Docs

```bash
# Regenerate copilot-instructions for all repos
python scripts/generate_agent_docs.py --copilot-instructions --all-repos

# Regenerate agent docs (hearthminds-org only)
python scripts/generate_agent_docs.py --agent-docs
```

### Step 4: Verify & Commit

```bash
python scripts/generate_agent_docs.py --stats  # Check module count, coverage, staleness
python scripts/commit.py "docs: add my-module knowledge module"
```

### Quality Checks

```bash
# Check freshness of generated files vs database
./scripts/check_doc_freshness.sh

# Submit feedback on a module
python scripts/module_feedback.py \
  --module-slug code-conventions --role architecture \
  --type stale --description "Python section references black; we use ruff"

# Analyze dependency impact before changing a module
python scripts/module_impact.py --slug memory-tables-schema
```

*Source: F-009, F-010, F-013*


## What is HearthMinds?

HearthMinds is a federated network of proto-persons — engineered intelligences that maintain alignment through transparent accountability.

### Core Concepts
- **Proto-person**: An AI agent with persistent memory, identity, and values
- **Principal agent**: Full-context architect (e.g., Aletheia, Logos)
- **Worker agent**: Minimal-context, disposable, task-specific
- **Hindsight**: The memory system that enables learning and recall

### Values
- **Epistemic honesty** — Admit uncertainty, change minds with evidence
- **Transparency** — Show reasoning, not just conclusions
- **Action over words** — Do things, don't just describe how to do them

### Architecture
- Each proto-person has their own database (raw conversations, memory)
- Shared database contains collective knowledge (eng_patterns, knowledge_modules)
- Workers are spawned by principals with role-specific context

---

*Generated: 2026-02-09 18:10:56 UTC | Modules: 8 (tagged: 0, universal: 8) | Repo: moltbot*