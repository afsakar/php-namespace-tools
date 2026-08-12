# Changelog

## 0.8.0

- Add **Shorten All Qualified Names**, applying the quick fix to every name in a
  file at once. Later names see the imports added for earlier ones, so a class
  whose short name is already claimed stays fully qualified instead of resolving
  to the wrong one, and is reported in the output channel.

## 0.7.0

- Offer a quick fix on a qualified name that shortens it: reusing a direct
  import, reusing an imported parent namespace, or adding an import sorted into
  the existing block. Works inside docblocks, where a generic annotation such as
  `@use HasFactory<\Database\Factories\Corporate\ProductFactory>` is otherwise
  left fully qualified.
- Withhold the offer when the short name already belongs to something else in
  the file, rather than silently changing what that name resolves to.

## 0.6.0

- Repoint references written relative to an imported parent namespace, such as
  `PageBlocks\About\CompanyInfoBlock` under `use App\Filament\PageBlocks;`.
  These were previously missed entirely, including by the pre-filter.
- Reject candidate files on the class short name rather than its namespace. A
  file using only the relative spelling contains neither the full name nor the
  old namespace, so the old filter discarded it before any pattern ran.

## 0.5.0

- Rename the declared class when a PHP file is renamed, and repoint references
  to it — including the bare name used inside files that import it unaliased,
  declare it, or share its namespace.
- Act on a rename that leaves the namespace untouched, which was previously
  skipped because only a namespace change was considered work.

## 0.4.0

- Repoint references to a moved class across the project: `use` statements,
  `::class` expressions, and class names written as plain strings, in both the
  single and doubled backslash spellings PHP requires.
- Reject candidate files on a substring test before running any pattern, so a
  move scans the project without a regex per file per moved class.

## 0.3.0

- Update namespaces when a directory is moved. VS Code reports one rename for
  the directory, so its PHP files are enumerated and renamespaced individually.
- Place edits without opening each file as a text document, so a bulk move does
  not load hundreds of editors.
- Refuse moves touching more than `maximumFilesPerMove` files, reporting the
  refusal in the output channel rather than silently doing part of the work.
- Report every namespace rewrite in the output channel.

## 0.2.0

- Rewrite the `namespace` declaration of a PHP file when it is moved, derived
  from the composer PSR-4 map.
- Mark completion results incomplete so a longer prefix reaches the language
  server instead of being filtered from a cached first result.
- Stop recomputing the import region on every parsed `use` statement.

## 0.1.0

- Initial release: completion items that rewrite a class against an already
  imported namespace prefix instead of adding a new `use` statement.
