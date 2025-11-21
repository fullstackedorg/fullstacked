ARCH=$(uname -i)
ARCH2=$(uname -i)

 if [[ $(uname -a) == *"x86_64"* ]]; then 
    ARCH="x64"
    ARCH2="amd64"
else
    ARCH="arm64"
    ARCH2="arm64"
fi

mkdir ~/.bin

# nodejs
curl -o ~/node.xz -L https://nodejs.org/dist/v24.11.1/node-v24.11.1-linux-$ARCH.tar.xz
mkdir ~/.bin/node
tar -xvf ~/node.xz -C ~/.bin/node --strip-components=1

# golang
curl -o ~/go.xz -L https://go.dev/dl/go1.25.4.linux-$ARCH2.tar.gz
mkdir ~/.bin/go
tar -xvf ~/go.xz -C ~/.bin/go --strip-components=1

rm -rf ~/*.xz

# bash profile
echo PATH=\$PATH:\$HOME/.bin/node/bin:\$HOME/.bin/go/bin >> ~/.bashrc

# clone git
mkdir ~/fullstackedorg
git clone https://github.com/fullstackedorg/fullstacked.git ~/fullstackedorg/fullstacked

# init submodules
cd ~/fullstackedorg/fullstacked 
git submodule update --init 
