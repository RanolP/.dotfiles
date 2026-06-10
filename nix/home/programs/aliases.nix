{
  rebuild = "sudo darwin-rebuild switch --flake ~/.dotfiles/nix#ranolp-work-MBP-26";
  cat = "bat";
  ls = "eza --icons=auto --git --group-directories-first --header --time-style=relative";

  pr = "gh pr view -w";
  repo = "gh repo view -w";

  gl = "git pull";
  gp = "git push";
  gc = "git commit -v";
}
