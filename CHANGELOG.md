# Changelog

## 0.2.0

- Rewrite the `namespace` declaration of a PHP file when it is moved, derived
  from the composer PSR-4 map. Only the moved file is edited; imports of it
  elsewhere are left for the language server to flag.
- Mark completion results incomplete so a longer prefix reaches the language
  server instead of being filtered from a cached first result.
- Stop recomputing the import region on every parsed `use` statement.

## 0.1.0

- Initial release: completion items that rewrite a class against an already
  imported namespace prefix instead of adding a new `use` statement.
