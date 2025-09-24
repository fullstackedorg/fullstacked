package connect

import (
	"encoding/base64"
	"fmt"
	"fullstackedorg/fullstacked/src/serialize"
	"fullstackedorg/fullstacked/src/setup"
	"net"
	"strconv"
	"time"
)

type Channel struct {
	ProjectId string
	Id        string
	Name      string
	Port      int
	Host      string
	Raw       bool
	buffer    []byte
	conn      net.Conn
}

func (c *Channel) connect() {
	fmt.Println("Connecting to " + c.Host + ":" + strconv.Itoa(c.Port))

	conn, err := net.DialTimeout("tcp", c.Host+":"+strconv.Itoa(c.Port), time.Second)
	if err != nil {
		fmt.Println(err)
		return
	}

	_, err = conn.Write(serialize.SerializeString(c.Name))
	if err != nil {
		fmt.Println(err)
		return
	}

	c.conn = conn
}

func (c *Channel) start() {
	if c.conn == nil {
		return
	}

	for {
		buf := make([]byte, 1024)
		size, err := c.conn.Read(buf)
		if err != nil {
			fmt.Println(err.Error())
			return
		}

		if c.Raw {
			setup.Callback(c.ProjectId, "channel-"+c.Id, base64.RawStdEncoding.EncodeToString(buf[0:size]))
		} else {
			c.buffer = append(c.buffer, buf[0:size]...)
			c.receive()
		}
	}
}

func (c *Channel) receive() {
	if len(c.buffer) < 4 {
		return
	}

	bodyLength := serialize.DeserializeBytesToInt(c.buffer[0:4])
	if len(c.buffer) < bodyLength+4 {
		return
	}

	body := c.buffer[4 : 4+bodyLength]
	setup.Callback(c.ProjectId, "channel-"+c.Id, base64.RawStdEncoding.EncodeToString(body))

	c.buffer = c.buffer[4+bodyLength:]
	if len(c.buffer) > 0 {
		c.receive()
	}
}

func (c *Channel) send(data []byte) {
	if c.conn == nil {
		return
	}
	c.conn.Write(data)
}
