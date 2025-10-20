package server

import (
	"fmt"
	"net"
	"strconv"

	"fullstackedorg/fullstacked/src/serialize"
)

type DataServer struct {
	raw      bool
	server   net.Listener
	channels map[string]*DataChannel
}

func NewServer(port int) (*DataServer, error) {
	return NewServerWithHostname(port, "localhost")
}

func NewServerWithHostname(port int, hostname string) (*DataServer, error) {
	address := hostname + ":" + strconv.Itoa(port)
	server, err := net.Listen("tcp", address)

	if err != nil {
		return nil, err
	}

	dataServer := DataServer{
		raw:      false,
		server:   server,
		channels: map[string]*DataChannel{},
	}

	go dataServer.start()

	return &dataServer, nil
}

func (dataServer *DataServer) start() {
	c, err := dataServer.server.Accept()
	if err != nil {
		fmt.Println(err)
		return
	}

	go dataServer.handleConnection(c)
}

func (dataServer *DataServer) handleConnection(c net.Conn) {
	dataSocket := DataSocket{
		socket:  c,
		buffer:  []byte{},
		channel: nil,
	}

	for {
		buffer := make([]byte, 1024)
		n, err := c.Read(buffer)

		if err != nil {
			fmt.Println(err)
			return
		}

		dataSocket.buffer = append(dataSocket.buffer, buffer[0:n]...)

		keepProcessing := true
		for keepProcessing {
			if dataSocket.channel == nil {
				keepProcessing = dataServer.tryUpgrade(&dataSocket)
			} else {
				keepProcessing = dataSocket.tryReceive()
			}
		}

	}
}

func (dataServer *DataServer) tryUpgrade(dataSocket *DataSocket) bool {
	if dataSocket.buffer[0] != serialize.STRING {
		dataSocket.socket.Close()
		return false
	}

	if len(dataSocket.buffer) < 5 {
		return false
	}

	dataLength := serialize.DeserializeBytesToInt(dataSocket.buffer[1:5])
	if dataLength > len(dataSocket.buffer)-5 {
		return false
	}

	channelName := string(dataSocket.buffer[5 : 5+dataLength])
	dataChannel, ok := dataServer.channels[channelName]
	if !ok {
		dataSocket.socket.Close()
		fmt.Println("Socket trying to connect to unknown channel [" + channelName + "]")
		return false
	}

	fmt.Println("Socket upgrading to channel [" + channelName + "]")

	dataSocket.buffer = dataSocket.buffer[5+dataLength:]
	dataSocket.channel = dataChannel
	dataChannel.dataSockets = append(dataChannel.dataSockets, dataSocket)
	return true
}

func (dataServer *DataServer) CreateChannel(name string) *DataChannel {
	dataChannel := &DataChannel{
		name:        name,
		dataSockets: []*DataSocket{},
	}
	dataServer.channels[name] = dataChannel
	return dataChannel
}

type DataChannel struct {
	name        string
	dataSockets []*DataSocket
	OnData      func([]any)
}

func (dataChannel *DataChannel) Send(args []any) {
	body := serialize.SerializeArgs(args)
	bodyLength := len(body)
	payload := serialize.SerializeIntToBytes(bodyLength)
	payload = append(payload, body...)
	for _, dataSocket := range dataChannel.dataSockets {
		dataSocket.socket.Write(payload)
	}
}

type DataSocket struct {
	socket  net.Conn
	buffer  []byte
	channel *DataChannel
}

func (dataSocket *DataSocket) tryReceive() bool {
	if len(dataSocket.buffer) < 4 {
		return false
	}

	bodyLength := serialize.DeserializeBytesToInt(dataSocket.buffer[0:4])
	if bodyLength > len(dataSocket.buffer)-4 {
		return false
	}

	if dataSocket.channel.OnData == nil {
		fmt.Println("No OnData func for channel [" + dataSocket.channel.name + "]")
		return false
	}

	body := dataSocket.buffer[4 : 4+bodyLength]
	dataSocket.channel.OnData(serialize.DeserializeArgs(body))
	dataSocket.buffer = dataSocket.buffer[4+bodyLength:]
	return true
}
