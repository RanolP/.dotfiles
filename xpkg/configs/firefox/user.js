// Firefox reads user.js on every start and overwrites these prefs with it, so
// edits made in Settings last only until the next start. Deleting a line here
// does NOT reset its pref; reset it in about:config.
//
// Font names are the Windows family names of the fonts xpkg/apps/@fonts
// installs; macOS names its Iosevka build differently ("Iosevka Nerd Font Mono").

user_pref("font.default.ko", "sans-serif");
user_pref("font.name.sans-serif.ko", "Pretendard");
user_pref("font.name.monospace.ko", "IosevkaTerm NF");

user_pref("font.default.x-western", "sans-serif");
user_pref("font.name.sans-serif.x-western", "Pretendard");
user_pref("font.name.monospace.x-western", "IosevkaTerm NF");
