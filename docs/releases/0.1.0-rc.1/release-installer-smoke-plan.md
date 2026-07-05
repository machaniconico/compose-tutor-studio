# Release Installer Smoke Plan

Generated at: 2026-06-30T18:56:31.886Z

Manifest: `apps/studio/src-tauri/target/release/release/release-manifest.json`

Installer metadata report: `apps/studio/src-tauri/target/release/release/release-installer-metadata-report.json`

Overall result: Pass

This plan is candidate-specific and does not install, launch, or uninstall anything by itself. Run these commands only in a clean Windows VM, disposable test account, or explicitly approved QA machine. Record the actual result in the candidate QA log.

| Artifact | File | SHA-256 |
|---|---|---|
| NSIS installer | `apps/studio/src-tauri/target/release/bundle/nsis/Compose Tutor Studio_0.1.0_x64-setup.exe` | `7922bf279320a055c9d193f936765de51319b6dbfcd3848cb227aacd3e0d96f9` |
| MSI installer | `apps/studio/src-tauri/target/release/bundle/msi/Compose Tutor Studio_0.1.0_x64_en-US.msi` | `0fdaf46073d5ddb05742a35ab600f245ceb54f1d10c80211dfaca02e5be652e8` |
| Portable exe | `apps/studio/src-tauri/target/release/cts-studio.exe` | `a98e6ae81d9d0dd7fec9996a5c1b3bfb9f00f6276b63611741904917413c4941` |

MSI ProductCode: `{BDE079B9-44B7-4DB1-B7E1-7FBE18DA525A}`

| ID | Purpose | Command | Expected result |
|---|---|---|---|
| PRE-001 | Confirm the candidate artifacts and installer metadata match the release manifest before touching the machine. | `pnpm release:verify; pnpm release:installers:verify` | Both commands pass for the same candidate build. |
| REL-MAN-001-NSIS-INSTALL | Install the NSIS candidate in a clean Windows VM or disposable test account. | `Start-Process -FilePath 'D:\workspace\compose-tutor-studio\apps\studio\src-tauri\target\release\bundle\nsis\Compose Tutor Studio_0.1.0_x64-setup.exe' -Wait -PassThru` | Installer completes without error and the app can be found from Start or the install directory. |
| REL-MAN-001-NSIS-SILENT-OPTIONAL | Optional unattended NSIS install check for repeatable QA environments. | `Start-Process -FilePath 'D:\workspace\compose-tutor-studio\apps\studio\src-tauri\target\release\bundle\nsis\Compose Tutor Studio_0.1.0_x64-setup.exe' -ArgumentList '/S' -Wait -PassThru` | Process exits successfully. If this differs from the interactive install, record the difference in the QA log. |
| REL-MAN-001-NSIS-LAUNCH-PROBE | Probe the default per-user Tauri NSIS install location and launch if present. | `$exe = Join-Path $env:LOCALAPPDATA 'Programs\Compose Tutor Studio\Compose Tutor Studio.exe'; if (Test-Path -LiteralPath $exe) { Start-Process -FilePath $exe } else { Write-Host "Expected exe not found: $exe" }` | Compose Tutor Studio opens. If installed elsewhere, launch from Start and note the actual path. |
| REL-MAN-001-NSIS-UNINSTALL | Uninstall the NSIS candidate after launch checks. | `$uninstaller = Join-Path $env:LOCALAPPDATA 'Programs\Compose Tutor Studio\uninstall.exe'; if (Test-Path -LiteralPath $uninstaller) { Start-Process -FilePath $uninstaller -ArgumentList '/S' -Wait -PassThru } else { Write-Host 'Use Windows Settings > Installed apps to uninstall.' }` | The app is removed and no stale Start/menu shortcut remains for this candidate. |
| REL-MAN-002-MSI-INSTALL | Install the MSI candidate in a clean Windows VM or disposable test account. | `Start-Process msiexec.exe -ArgumentList '/i', 'D:\workspace\compose-tutor-studio\apps\studio\src-tauri\target\release\bundle\msi\Compose Tutor Studio_0.1.0_x64_en-US.msi', '/qn', '/norestart', 'ALLUSERS=2', 'MSIINSTALLPERUSER=1', '/L*v', 'D:\workspace\compose-tutor-studio\apps\studio\src-tauri\target\release\release\msi-install-smoke.log' -Wait -PassThru` | msiexec exits successfully and the app can be launched from the installed location or Start. |
| REL-MAN-002-MSI-UNINSTALL | Uninstall the MSI candidate by ProductCode after launch checks. | `Start-Process msiexec.exe -ArgumentList '/x', '{BDE079B9-44B7-4DB1-B7E1-7FBE18DA525A}', '/qn', '/norestart', '/L*v', 'D:\workspace\compose-tutor-studio\apps\studio\src-tauri\target\release\release\msi-uninstall-smoke.log' -Wait -PassThru` | msiexec exits successfully and the app is removed from Windows installed apps. |
