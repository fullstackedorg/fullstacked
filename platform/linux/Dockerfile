FROM debian:latest

COPY ./install.sh /root/install.sh
RUN chmod +x /root/install.sh

RUN apt update && apt upgrade -y
RUN apt install curl xz-utils git make cmake build-essential python3 \
                libgtkmm-4.0-dev libwebkitgtk-6.0-dev \
                qt6-base-dev qt6-webengine-dev -y

RUN /root/install.sh

WORKDIR /root