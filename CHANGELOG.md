# Changelog

All notable changes to AmphiLink CFG Tool are documented here.

## [1.0.1] - 2026-08-29

### Fixed

- The Windows OpenOCD prerelease installer now discovers the current archive through the GitHub Releases API and verifies its SHA-256 digest when available.

## [1.0.0] - 2026-08-22

### Added

- Environment checks for Cortex-Debug, GDB, OpenOCD, and CMSIS-DAP TCP capability.
- Cross-platform GDB and OpenOCD discovery with manual path fallback.
- Wired USB, LAN wireless, and AmphiLink hotspot discovery.
- STM32CubeMX/CMake, generic CMake, PlatformIO, and manual project detection.
- Managed OpenOCD configuration and Cortex-Debug `launch.json` generation.
- Chinese and English UI and documentation.
