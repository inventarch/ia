# Records

**A record is one `@word name` block in a `.ia` file. Everything IA knows about your project is a record: requirements, decisions, tasks, rules, checks, agents and evidence.**

This page covers how to write one. [Words and systems](words-and-systems.md) covers which words exist, and the [language reference](../reference/language/README.md) has the exact grammar.

## A file

```ia
#! ia 1.0

# A line that starts with a hash is a comment.
@decision list-format
  meaning
    says "Choose the file format of an exported shopping list."
  work
    title "Shopping-list file format"
    status made
    owner "Priya"
  decision
    question "Which file format does the export produce?"
    options ["Markdown checklist", "CSV", "PDF"]
    choice "Markdown checklist"
```

- **The first line is always `#! ia 1.0`.** A file without it is refused with `IA-LANG-PRAGMA-MISSING`.
- **A file can hold any number of records.** Put them wherever is convenient. Pantry keeps its plan in `shopping-list.ia`, its rules in `rules.ia` and its checks in `checks.ia`.
- **Files go anywhere under `.ia/src/`**, in any subfolder. Two folders are special: `.ia/src/floor/`, which would replace the language itself, and `.ia/src/systems/`, which holds systems you define yourself (see [Your own vocabulary](your-own-vocabulary.md)).
- **Files are UTF-8 text** and belong in git with your code.

## A record

`@decision list-format` starts a record:

- **The word** (`decision`) says what kind of record it is. It decides which sections and fields the record must and may have.
- **The name** (`list-format`) starts with a letter and uses letters, digits and hyphens. It must be unique for that word.

Below the header, indented by two spaces, come **sections** (`meaning`, `work`, `decision`). Inside each, indented two more spaces, come **fields**: a key, a space and a value. Indentation is always two spaces per level; a tab is refused with `IA-LANG-INDENT-TAB`.

Almost every word has a `meaning` section with `says` (one sentence: what this record is) and often `answers` (the question it answers). Tools and agents read these first, so make them specific.

A few words take **head fields**, which come before the first section. A contract's version is one:

```ia
@contract pantry-records
  version "1.0.0"
  meaning
    says "What Pantry's own records must satisfy."
```

## Values

| Kind | Write it as | Example |
| --- | --- | --- |
| Text | In double quotes | `title "Shopping-list export"` |
| Long text | Between triple quotes, over several lines | see below |
| Identifier | A bare word: letters, digits and hyphens | `status open` |
| Number | Digits, with an optional sign and decimals | `limit-model-calls 4` |
| Flag | `true` or `false`, or just the key | No public word uses one; your own words may |
| Reference | `@word name` | `milestone @milestone export-ready` |
| List | Items in square brackets, separated by commas | `options ["Markdown checklist", "CSV"]` |

Long text:

```ia
    says """
      Choose a storage engine for the event log.
      Prose may span several lines.
      """
```

A list may span several lines and may end with a trailing comma. Lists do not nest.

Which kind a field takes, and which identifiers are allowed, is part of the word's schema. Run `ia preview <word>` to see it:

```text
  must work.status         id in [open, made, superseded, withdrawn]
  may decision.options     list of text
```

## Comments

`#` starts a comment at the beginning of a line, or after a space. Inside a reference such as `@contract pantry-records#REQ-RECORDS-CONFORM`, the `#` is not a comment: it points at one part of the record (see [References](#references)). `ia format` keeps comments.

## References

A **reference** points at another record by word and name:

```ia
  work
    milestone @milestone export-ready
```

IA checks that the record exists and is the right word. A reference to a record that does not exist is reported when you validate.

Some records have named parts, and a reference can point at one of them with `#`:

- a requirement inside a contract: `@contract pantry-records#REQ-RECORDS-CONFORM`;
- a cell of a playbook, by phase and primitive: `@playbook release-steps#act/Decision`.

## Relationships

A field holds one value. To link a record to others with a verb, use a `relationships` section, with one row per link:

```ia
@task add-export-button
  …
  relationships
    requires @task write-exporter
    grounded-by @decision list-format
```

Each row is a **predicate** and a target. There are 18 predicates, and each can be written from either end. `@decision list-format grounds @task add-export-button` and `@task add-export-button grounded-by @decision list-format` state the same link:

| Predicate | Written as | Means |
| --- | --- | --- |
| require | `requires` / `required-by` | Needs the target to be present first |
| ground | `grounds` / `grounded-by` | Is the basis the target rests on |
| supersede | `supersedes` / `superseded-by` | Replaces the target |
| govern | `governs` / `governed-by` | The target is subject to this record's rules |
| enforce | `enforces` / `enforced-by` | Checks or applies the target |
| implement | `implements` / `implemented-by` | Realizes the target, or is a case that exercises it |
| constrain | `constrains` / `constrained-by` | Bounds what the target may be or do |
| forbid | `forbids` / `forbidden-by` | Prohibits the target |
| cite | `cites` / `cited-by` | Refers to the target as a source |
| use | `uses` / `used-by` | Draws on the target without needing it |
| produce | `produces` / `produced-by` | Yields the target as an output |
| consume | `consumes` / `consumed-by` | Takes the target as an input |
| trigger | `triggers` / `triggered-by` | Starts the target at some moment |
| run-before | `runs before` / `run-after` | Runs earlier than the target |
| route | `routes to` / `routed-by` | Directs flow to the target |
| record-lineage-from | `records lineage from` / `lineage-recorded-by` | Traces its origin to the target |
| grant-access-to | `grants access to` / `access-granted-by` | Declares that reaching the target is permitted |
| land | `lands at` / `landed-by` | Published content arrives at the target |

Not every word may use every predicate with every other word. Each system says which links its words accept: a task may `require` another task, milestone or decision, for example. A link no system allows is refused with `IA-LANG-EDGE-UNCONSENTED` or `IA-GRAPH-EDGE-UNCONSENTED`. `ia preview <word>` lists the links a word may take under **Edges** and **Consent**.

A row can also carry a condition, such as `governs @playbook review when phase is act`. The [language reference](../reference/language/README.md) covers conditions.

## Identity

Every record has a full **identity** of four parts: `system/kind/facet/name`.

| You write | Its identity |
| --- | --- |
| `@decision list-format` | `work-system/definition/decision/list-format` |
| `@spec shopping-list-export` | `work-system/contract/spec/shopping-list-export` |
| `@law lists-stay-local` | `governance-system/governance/law/lists-stay-local` |
| `@check records-conform` | `compliance-system/check/gate/records-conform` |

- **system** is the system that owns the word.
- **kind** is one of seven broad roles, such as `definition`, `contract` or `governance`. IA uses it to decide where a record fits in an agent's context.
- **facet** is usually the word itself. A few words use another facet: `@check` is `gate`, `@contract` is `signature`, `@case` is `scenario` and `@playbook` is `procedure`.
- **name** is the record's name, lowercased.

Inside records you always write the short form, `@decision list-format`. Commands such as `ia position`, `ia read` and `ia inspect` show and take the full identity. Moving a record to another file does not change its identity.

Two records with the same identity both fail: `IA-LANG-IDENTITY-COLLISION` within one file, `IA-GRAPH-IDENTITY-TIE` across files.

## Writing records

You can write records three ways:

- **By hand**, in any editor, then run `ia validate`. The [VS Code extension](connecting-agents.md#the-vs-code-extension) checks as you type.
- **With `ia preview` and `ia author`**, which show a change, then apply exactly that change and record who made it:

  ```sh
  ia preview decision api-version "meaning.says=Choose how the API is versioned." "work.title=API versioning" "work.status=open" "decision.question=How is the API versioned?"
  ia preview --set "@decision api-version" "decision.choice=URL prefix"
  ia preview --relate "@task write-exporter" grounded-by "@decision list-format"
  ```

  Each preview prints the target file's `sha256`. Running `ia author` with the same arguments and `--digest <sha256>` writes the change, and only if the file has not changed since. A new record goes to `.ia/src/<word>.ia` unless you add `--at <path>`. See [Agents and authority](agents-and-authority.md#the-governed-write-path).
- **By an agent**, using the same two commands.

`ia format` checks layout and `ia format --write` fixes it, keeping comments and blank lines.

## Common mistakes

| You see | Because |
| --- | --- |
| `IA-LANG-PRAGMA-MISSING` | The file does not start with `#! ia 1.0` |
| `IA-LANG-INDENT-TAB` or `IA-LANG-INDENT-STEP` | A tab, or indentation that is not a multiple of two spaces |
| `IA-LANG-DISCRIMINATOR-UNREGISTERED` | A word that no system defines, often a typo such as `@desicion` |
| `IA-COMP-FIELD-MISSING` / `IA-COMP-SECTION-MISSING` | A required field or section is missing |
| `IA-COMP-FIELD-UNKNOWN` / `IA-COMP-SECTION-UNKNOWN` | A field or section the word does not have |
| `IA-COMP-FIELD-VALUE` | A value outside the allowed set, such as `status done` |
| `IA-GRAPH-TARGET-MISSING` | A relationship points at a record that does not exist |
| `IA-COMP-FIELD-REF-MISSING` | A reference field points at a record that does not exist |

[Troubleshooting](troubleshooting.md) has a longer list.
