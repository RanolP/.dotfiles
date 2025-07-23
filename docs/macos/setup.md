# macOS Setup

## 0. Install macOS Normally

## 1. Make the Filesystem Case-Sensitive

- Start macOS with Recovery Mode [ref](https://support.apple.com/en-asia/102518)
- Open Disk Utility
- Erase every volumes
  - When you delete the last volume, the dialog will appear; select `APFS (Case-senstive)` for `Format`.
  - Erase mac and Restart
- Activate Mac

After all the subsequence completed, reinstall macOS.

## 2. Install macOS again

Make sure you have time a lot.

- Language: English
- Country or Region: South Korea
- Accessibility: Not now
- Select Wi-Fi
- Migration Assistant: Not now
- Sign In with Your Apple ID: Set Up Later
- Createa a Computer Account
- Select Your Time Zone: Seoul
- Analytics: Uncheck "Share Mac Analytics with Apple"
- Siri: Uncheck "Enable Ask Siri"
- Choose Your Look: Dark

Almost there

## 3. Configure Settings

- System Settings > Dragging Style
  - Check "Use trackpad for dragging"
  - Dragging Style: "Three Finger Drag"
- System Settings > Control Center
  - Battery: Check "Show Percentage"
  - Clock > Clock Options: ""
  - Spotlight: "Don't Show in Menu Bar"
- Finder > Settings
  - New Finder windows show: "\<username\>"
  - Sidebar: Uncheck: ["Recents", "AirDrop", "Applications", "Bonjour computers", "Recent Tags"]
  - Advanced: Check "Show all filename extensions"
- Remove almost every apps from dock

## 4. Set up dotfiles

```sh
curl -L dotfiles.ranolp.dev/setup | sh
```
