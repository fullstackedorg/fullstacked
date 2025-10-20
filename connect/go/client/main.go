package client

import (
	"fmt"
	"fullstackedorg/fullstacked/src/serialize"
	"net"
	"strconv"
)

type DataClient struct {
	socket net.Conn
	buffer []byte
	OnData func([]any)
}

func NewClient(channel string, port int) (*DataClient, error) {
	return NewClientWithHostname(channel, port, "0.0.0.0")
}

func NewClientWithHostname(channel string, port int, hostname string) (*DataClient, error) {
	c, err := net.Dial("tcp", hostname+":"+strconv.Itoa(port))
	if err != nil {
		return nil, err
	}

	dataClient := DataClient{
		socket: c,
		buffer: []byte{},
	}

	dataClient.socket.Write(serialize.SerializeArgs([]any{channel}))

	go dataClient.start()

	return &dataClient, nil
}

func (dataClient *DataClient) start() {
	for {
		buffer := make([]byte, 1024)
		n, err := dataClient.socket.Read(buffer)

		if err != nil {
			fmt.Println(err)
			return
		}

		dataClient.buffer = append(dataClient.buffer, buffer[0:n]...)
		keepProcessing := true
		for keepProcessing {
			keepProcessing = dataClient.tryReceive()
		}
	}
}

func (dataClient *DataClient) tryReceive() bool {
	if len(dataClient.buffer) < 4 {
		return false
	}

	bodyLength := serialize.DeserializeBytesToInt(dataClient.buffer[0:4])
	if bodyLength > len(dataClient.buffer)-4 {
		return false
	}

	if dataClient.OnData == nil {
		fmt.Println("No OnData func for client")
		return false
	}

	body := dataClient.buffer[4 : 4+bodyLength]
	dataClient.OnData(serialize.DeserializeArgs(body))
	dataClient.buffer = dataClient.buffer[4+bodyLength:]
	return true
}

func (dataClient *DataClient) Send(args []any) {
	body := serialize.SerializeArgs(args)
	bodyLength := len(body)
	payload := serialize.SerializeIntToBytes(bodyLength)
	payload = append(payload, body...)
	dataClient.socket.Write(payload)
}
