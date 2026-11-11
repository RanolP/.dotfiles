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

// "Open previous windows and tabs": restore the last session on start.
user_pref("browser.startup.page", 3);

// "Vertical tabs".
user_pref("sidebar.revamp", true);
user_pref("sidebar.verticalTabs", true);

// "Show search suggestion".
user_pref("browser.search.suggest.enabled", true);
user_pref("browser.urlbar.suggest.searches", true);

// "Password and autofill = Bitwarden": switch Firefox's own off. about:logins
// stays reachable so old passwords can still be exported.
user_pref("signon.rememberSignons", false);
user_pref("signon.autofillForms", false);
user_pref("extensions.formautofill.addresses.enabled", false);
user_pref("extensions.formautofill.creditCards.enabled", false);
