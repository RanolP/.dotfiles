use ~/.dotfiles/utils/yesno.nu

if (yesno "Will you import public key?" true) {
    echo "$ keybase pgp export | gpg --import"
    keybase pgp export | (nu ~/.dotfiles/utils/@windows/git-bash.nu "gpg --import")
}
if (yesno "Will you import private key?" true) {
    echo "$ keybase pgp export --secret | gpg --allow-secret-key-import --import"
    keybase pgp export --secret | (nu ~/.dotfiles/utils/@windows/git-bash.nu "gpg  --allow-secret-key-import --import")
}

echo "$ gpg --list-secret-keys --keyid-format LONG"
let raw_key_output = (nu ~/.dotfiles/utils/@windows/git-bash.nu "gpg --list-secret-keys --keyid-format LONG") 
let parsed_key = ($raw_key_output | parse -r 'sec\s+[a-zA-Z0-9]+\/(?P<key>[a-zA-Z0-9]+).+\n.+\n(?P<uids>(?:\n?uid.+)+)') | each { |row| update uids ($row.uids | parse -r 'uid\s+\[[^]]+\]\s+(?P<uid>.+)' | get uid) }   
let selected_key = ($parsed_key | each { |row| $'($row.key)("\n")    ($row.uids | str join "\n    ")' } | input list 'Select the key to use') | split row "\n" | get 0
echo $"Use ($selected_key) as signing key"

echo $"$ git config --global user.signingkey $($selected_key)"
git config --global user.signingkey $selected_key
echo "$ git config --global commit.gpgsign true"
git config --global commit.gpgsign true
