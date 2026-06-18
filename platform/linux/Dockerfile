FROM debian:latest

COPY ./install.sh /root/install.sh
RUN chmod +x /root/install.sh

RUN apt update && apt upgrade -y
RUN apt install curl vim xz-utils git make cmake build-essential python3 \
                libgtkmm-4.0-dev libwebkitgtk-6.0-dev \
                qt6-base-dev qt6-webengine-dev \
                gcc-x86-64-linux-gnu g++-x86-64-linux-gnu \
                gcc-aarch64-linux-gnu g++-aarch64-linux-gnu -y


RUN /bin/bash /root/install.sh

WORKDIR /root