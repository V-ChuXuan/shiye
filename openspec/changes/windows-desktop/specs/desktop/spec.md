## ADDED Requirements

### Requirement: Explicit stale lock recovery
The Windows app SHALL offer recovery only for a validated lock owned by a dead process, SHALL revalidate its exact contents under a lifetime OS guard, and SHALL preserve the old lock. Active, unknown and incomplete libraries SHALL remain protected. New lock claims SHALL be published atomically without overwriting another claim.

#### Scenario: Abnormal process exit
- **WHEN** a dead owner leaves a valid lock and the user chooses recovery
- **THEN** at most one process opens the library, preserving the original lock record and data

### Requirement: Software adjacent default library
New packaged users SHALL default to executable-directory/library and pictures below it. Explicit or remembered roots SHALL take precedence. An unwritable default SHALL prompt for a location or exit without silently switching to AppData.

#### Scenario: Existing binding
- **WHEN** an upgraded user has a valid remembered library
- **THEN** the same library opens without migration

### Requirement: Data preserving installer
A Chinese per-user Windows x64 installer SHALL install the existing portable payload, shortcuts and an uninstaller. Upgrade and uninstall SHALL preserve user library and unknown files and SHALL NOT recursively delete the installation root or force-close a running app.

#### Scenario: Uninstall after use
- **WHEN** the installed app has saved a library and the user uninstalls it
- **THEN** installed program files and shortcuts are removed while library and user-created files remain intact
