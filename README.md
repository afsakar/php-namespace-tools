# PHP Namespace Tools

PhpStorm resolves a class against the namespaces you have already imported. Given
`use Filament\Forms;` in the file, picking `TextInput` from the completion list
inserts `Forms\Components\TextInput` and leaves the import block alone.

Every VS Code PHP language server instead adds a second `use` statement and
writes the bare short name. This extension adds the missing behaviour.

## Example

```php
use Filament\Forms;

// Type `TextI`, pick the suggestion:
Forms\Components\TextInput::make('title')

// Instead of a new `use Filament\Forms\Components\TextInput;`
// plus a bare `TextInput::make('title')`
```

## How it works

The extension does not build its own index. On each completion request it asks
VS Code for workspace symbols matching the typed prefix, which is answered by
whichever PHP language server you already run. Each result's fully qualified name
is matched against the `use` statements in the current file, and the longest
matching import becomes the prefix.

Consequences worth knowing:

- A PHP language server that indexes your project is required. Any of
  Intelephense, DevSense PHP Tools or Phpactor works.
- Running several language servers at once produces duplicate and
  poorly ordered suggestions. Enable exactly one.
- Suggestions only appear for namespaces you have already imported, or for
  classes under the file's own namespace. This is deliberate: the completion
  never adds an import, it only reuses what already resolves.

A class in a sub-namespace of the file's own needs no import at all, because
PHP resolves a qualified name against the current namespace. Typing
`ProductSeeder` inside `namespace Database\Seeders;` therefore offers
`Corporate\ProductSeeder`, the spelling a Laravel `DatabaseSeeder` already uses.
The offer is withheld when the leading segment is an imported alias, since PHP
checks imports first and the name would resolve elsewhere.

## Shorten a qualified name

Put the cursor on a fully qualified name anywhere in a file — including inside a
docblock, where no language server offers to help — and the lightbulb offers to
shorten it. Exactly one offer is made, decided by what the file already imports:

```php
/** @use HasFactory<\Database\Factories\Corporate\ProductFactory> */

// nothing imported      -> adds `use Database\Factories\Corporate\ProductFactory;`
//                          and leaves `HasFactory<ProductFactory>`
// parent namespace in   -> `HasFactory<Corporate\ProductFactory>`, no new import
// class already in      -> `HasFactory<ProductFactory>`, no new import
// short name taken      -> nothing offered, since importing would change what
//                          the existing name resolves to
```

A new import is sorted into the existing block, or opens one after the
`namespace` statement when there is none.

The reverse works too. On an unqualified class name the file does not resolve,
the lightbulb offers an import per class carrying that name, taken from the
workspace symbol index. A name already imported, declared in this file, or
living in this file's own namespace resolves as it stands and is passed over.

To be offered anything the name must begin with an upper case letter, as PSR-1
requires of a class. Without that rule every lower case identifier in the file
would raise an offer.

The quick fix acts on the name under the cursor. To do a whole file at once run
**PHP Namespace Tools: Shorten All Qualified Names**, which applies the same
decision to every name in document order. A class is imported once however many
times it appears, and when two different classes share a short name the first
one takes it while the rest are left fully qualified and listed in the output
channel — importing both would leave the file compiling with one of the names
resolving to the wrong class.

## Blade templates

The completion and both quick fixes work in Blade templates as well, using the
`@use` directive Laravel 11 introduced rather than a PHP `use` statement:

```blade
@use('App\Enums\Status')

<span>{{ Status::Active->label() }}</span>
```

Existing directives are read in every spelling Laravel's own compiler accepts —
quoted or bare, with an alias as a second argument, and the group form. A `@php`
block's plain `use` statements count as imports too. A new directive joins the
existing run in alphabetical order, or opens the file when there is none.

The `@use` tag inside a PHP docblock is never mistaken for a directive.

Removing unused imports and the PSR-4 check stay PHP only.

## Remove unused imports

**PHP Namespace Tools: Remove Unused Imports** deletes the `use` statements the
open file never refers to.

The search is deliberately reluctant. An alias mentioned in a comment or inside
a string counts as used, because the two mistakes are not equal: keeping a
redundant import is noise, while deleting a needed one stops the file
compiling. For the same reason three shapes are never touched:

- two statements sharing a line, whose spans would overlap
- group imports, where dropping one member means rewriting the statement
- `use function` and `use const`, a separate resolution space

Usages inside docblocks, attributes, `implements` clauses and trait `use`
statements all count, including inside an anonymous class body.

## Namespace conformance

A file whose `namespace` does not match its composer PSR-4 directory is flagged,
with a quick fix that corrects the declaration.

This exists because the move handling below only sees renames performed inside
VS Code. A file moved by git, by `mv`, by a merge or by another editor keeps a
namespace that no longer autoloads, and nothing in the editor says so.

Files outside every PSR-4 root, and files declaring no type at all, have nothing
to conform to and are never flagged. Set
`phpNamespaceTools.validateNamespace` to `false` to turn it off.

## Namespace on move

Moving a PHP file changes the namespace PSR-4 requires it to declare. VS Code
moves the file and leaves the stale declaration behind, so the class stops
autoloading. This extension rewrites that declaration from the `autoload` and
`autoload-dev` PSR-4 maps in `composer.json`, renames the class when the file
name changes, then repoints every reference across the project.

Everything a move rewrites is listed in the **PHP Namespace Tools** output
channel, and VS Code folds the edits into the same undo step as the move.

Read the ceiling before relying on it:

- **References are matched in all three spellings**: fully qualified, written
  relative to an imported parent namespace (`PageBlocks\About\CompanyInfoBlock`
  under `use App\Filament\PageBlocks;`), and bare. Matching is textual, not
  driven by the reference provider. That is what lets plain strings such as
  `'App\Models\User'` in a config file be repointed, which no PHP language
  server resolves. Comments naming the class are rewritten too.
- **Referencing files are found through `findFiles`**, so a path hidden by your
  `files.exclude` or `search.exclude` is never visited and keeps a stale import.
- **Directory moves are handled**, by enumerating the PHP files beneath the
  moved directory. Moves above `maximumFilesPerMove` files are refused outright.
- **A class is renamed only when it was named after its file.** `Foo.php`
  holding `class Foo` becomes `class Bar` when renamed to `Bar.php`; a file
  holding a differently named class is treated as moved, not renamed.
- **Bare names are rewritten only where they resolve to the renamed class**:
  files importing it unaliased, declaring it, or sharing its namespace. A name
  touching a quote is skipped, so a `'RichTextBlock'` key stays put — which also
  means a class name genuinely stored as a string is left behind.

Set `phpNamespaceTools.updateNamespaceOnMove` to `false` to turn it off.

## Rename a class

**PHP Namespace Tools: Rename Class and File** renames the class in the active
editor and its file together, then repoints every reference. PSR-4 ties the two
names to each other, so renaming either alone stops the class autoloading.

The command refuses when the file declares no type, and when the declared type
is not named after the file — there the two names are already independent and
guessing which one was meant would be wrong. An existing file at the target name
is never overwritten.

The edits and the rename travel in one workspace edit, so `Cmd+Z` undoes the
whole thing and the open editor follows the file to its new path.

## Selecting a variable

Double clicking `$property` selects only `property`, because VS Code treats `$`
as a word separator. PhpStorm selects the whole variable.

The extension ships a language-scoped default that drops `$` from
`editor.wordSeparators` for PHP and Blade, so a double click takes the whole
variable and word-wise cursor movement stops at its edges. It is only a default;
setting `editor.wordSeparators` yourself overrides it.

## Settings

| Setting | Default | Meaning |
| --- | --- | --- |
| `phpNamespaceTools.enabled` | `true` | Offer relative-namespace completions. |
| `phpNamespaceTools.minimumPrefixLength` | `3` | Characters typed before the symbol index is queried. Raise it if completion feels slow. |
| `phpNamespaceTools.maximumSuggestions` | `25` | Maximum relative suggestions per request. |
| `phpNamespaceTools.updateNamespaceOnMove` | `true` | Rewrite the namespace declaration of a moved file. |
| `phpNamespaceTools.maximumFilesPerMove` | `500` | Refuse a move touching more PHP files than this. |
| `phpNamespaceTools.updateImportsOnMove` | `true` | Repoint references to a moved class across the project. |
| `phpNamespaceTools.validateNamespace` | `true` | Warn when a namespace does not match its PSR-4 directory. |

## Troubleshooting

Run **PHP Namespace Tools: Debug Workspace Symbols** from the command palette
and enter a class name. The output channel shows what the language server
returned and how the current file's imports were parsed. If the symbol list is
empty or `containerName` carries no namespace, the language server is the
problem, not this extension.

## Development

```bash
npm test                      # pure parsing logic, no VS Code required
npx @vscode/vsce package      # build the .vsix
```

`npm test` stubs the `vscode` module so the import parsing and namespace
rewriting can be exercised in plain Node.

## Licence

MIT
