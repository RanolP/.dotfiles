sudo pacman -S --needed base-devel
(cd ~; git clone https://aur.archlinux.org/paru.git; cd paru; makepkg -si)
rm -rf ~/paru