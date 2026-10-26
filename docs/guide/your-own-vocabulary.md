# Your own vocabulary

**When none of IA's 44 words fits something your project needs to record, define a new word. A word lives in a system you own, with a schema that says what its records contain. You can then use it in the same workspace, or package the system and install it elsewhere.**

Prefer an existing word when one fits; a `@spec`, `@decision` or `@law` covers a great deal. Define a word when you will write many records of a kind no existing word describes.

This page builds a small system, `kitchen`, with one word: `@allergen`, for the allergens a recipe can contain. The files are in [`examples/pantry/kitchen`](../../examples/pantry/kitchen/).

## 1. Create a workspace with a system folder

```sh
ia init . --id local/kitchen --system --host none --apply --yes
```

`--system` adds a system named after the workspace, in its own folder:

```text
.ia/src/
├── workspace.ia                         # the usual starter records
└── systems/kitchen/
    ├── system.ia                        # @system kitchen and its steward @agent kitchen-steward
    └── records/distribution.ia          # @distribution kitchen-distribution: what a release ships
```

`.ia/release.json` names that distribution, so `ia pack` can build a release of the system.

## 2. Register the word

Edit `.ia/src/systems/kitchen/system.ia`. Add a `discriminators` entry for the word and an `edges` section for the relationships it accepts, and add the word to the steward's `applies`:

```ia
#! ia 1.0

@system kitchen
  provider "local"
  version "0.1.0"
  describes "Kitchen words for Pantry: the allergens a recipe can contain."
  steward @agent kitchen-steward
  requires
    - agent-system
    - work-system
    - workspace-system
  discriminators
    allergen lowers to definition
      category state
      facets [allergen]
      schema @schema allergen
  edges
    cite * using *

@agent kitchen-steward
  meaning
    says "Owns the kitchen system and its records."
    answers "Who owns this system?"
  governance
    applies [allergen]
```

| Part | Says |
| --- | --- |
| `allergen lowers to definition` | The new word, and the [kind](words-and-systems.md#the-languages-own-words) of record it is: `definition`, `contract`, `governance`, `check`, `policy`, `binding` or `template` |
| `category` | Its category, from a closed list such as `state`, `process` or `decision` |
| `facets` | The facets its identities may use; the first is the default, and usually the word itself |
| `schema` | The `@schema` that defines its fields |
| `edges` | Consent rows: `<predicate> <target words> using <source words>`. `cite * using *` lets any record cite any other. |
| `requires` | The systems whose words records in this folder may use |
| The steward's `applies` | Must list every word the system registers |

## 3. Write its schema

Create `.ia/src/systems/kitchen/schemas/allergen.schema.ia`:

```ia
#! ia 1.0

@schema allergen
  lowers to definition
  sections
    must have meaning
    must have allergen
    may have relationships
    closed
  fields
    must have meaning.says as text
    must have allergen.label as text
    must have allergen.severity as id in [mild, serious, life-threatening]
    may have allergen.also-called as list of text
```

Field types are `text`, `id`, `number`, `flag`, `ref` and `qname`, or `list of` one of them. Narrow an identifier with `id in [...]`, a reference with `ref to <word>`, and a date with `text form iso-date`. `closed` refuses any section or field not listed.

## 4. Use it

```sh
ia validate
ia preview allergen
```

```text
Word  allergen                kitchen

  lowers to  definition (category state; facets allergen)
  schema     allergen, closed
  file       .ia/src/allergen.ia (new), sha256
…
Fields
  must meaning.says         text
  must allergen.label       text
  must allergen.severity    id in [mild, serious, life-threatening]
  may allergen.also-called  list of text

Consent
  kitchen: cite * using *
```

Now write records with it, by hand or through `ia preview` and `ia author`:

```ia
@allergen peanuts
  meaning
    says "Peanuts and anything made from them."
  allergen
    label "Peanuts"
    severity life-threatening
    also-called ["groundnuts"]
```

Its identity is `kitchen/definition/allergen/peanuts`.

`ia author` will not write `@system` or `@schema` records; edit them by hand. `ia vocabulary` lists only the public words, so use `ia preview <word>` to look yours up.

## 5. Share it

To use `@allergen` in another workspace, such as Pantry, package the system and install it there. Commit first, then pack:

```sh
ia pack --descriptor .ia/release.json
```

```text
Pack  local/kitchen 0.1.0                         ~/kitchen/.ia/work/dist

  ✔  3 files, 1110 bytes expanded.
…
Members
  •  .ia/src/systems/kitchen/records/distribution.ia
  •  .ia/src/systems/kitchen/schemas/allergen.schema.ia
  •  .ia/src/systems/kitchen/system.ia
```

The archive holds the system folder only: the word and its schema, not records that use it elsewhere in the workspace. [Distributions and kits](distributions-and-kits.md) shows how to install it.

## Rules and limits

- **A word's spelling** is lowercase letters, digits and hyphens, starting with a letter. `system`, `schema` and `any-adopter` are reserved.
- **One owner per word.** Each word is registered by one system. A word two systems register at the same band is refused for both.
- **Records inside a system folder** may use only that system's words, `@system`, `@schema` and the words of the systems it `requires`. Anything else is refused with `IA-COMP-DISCRIMINATOR-FOREIGN`. Records outside system folders may use any word.
- **New words never extend the closed lists.** Kinds, categories, predicates, moves and phases are fixed; a new word picks from them.
- **Do not register a word again** to change an installed one. Define a separate word in your own system and link it.

| You see | Because |
| --- | --- |
| `IA-COMP-STEWARD-MISSING` | The steward's `applies` does not list every registered word |
| `IA-LANG-SCHEMA-MISSING` | The registration names a `@schema` no file declares |
| `IA-COMP-CONSENT-EMPTY` (warning) | No `edges` row mentions the word, so it can have no relationships |
| `IA-LANG-KEYWORD-RESERVED` | The word is reserved |
| `IA-COMP-DISCRIMINATOR-FOREIGN` | A record in a system folder uses a word from a system that folder does not require |

The [language reference](../reference/language/README.md#defining-vocabulary) gives the full grammar of `@system` and `@schema`.
