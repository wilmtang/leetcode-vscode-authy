# Browser Extension Change Log
All notable changes to the "LeetCode VS Code Auth Sync" browser extension will be documented in this file.

Check [Keep a Changelog](http://keepachangelog.com/) for recommendations on how to structure this file.

## [0.1.4]
### Added
- Capture and sync LeetCode browser request headers, including Firefox headers, so the VS Code extension can replay authenticated test requests more reliably.
- Add a cookie-only sync mode in the popup and options page.
- Add an expire-now action to clear cached sync data and force a fresh sync.

## [0.1.3]
### Changed
- Improve the add-on listing with clearer installation and auth-sync instructions.

## [0.1.2]
### Changed
- Remove Firefox Android compatibility from release metadata.

## [0.1.1]
### Fixed
- Fix Firefox publishing dependency sources.

## [0.1.0]
### Added
- Add the Firefox Add-ons publishing workflow and browser-extension release lane.
