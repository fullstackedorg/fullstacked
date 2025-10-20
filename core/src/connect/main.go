package connect

import (
	"fullstackedorg/fullstacked/src/utils"
)

var channels = map[string]Channel{}

func Connect(
	projectId string,
	name string,
	port float64,
	host string,
	raw bool,
) string {
	channelId := utils.RandString(6)
	channel := Channel{
		ProjectId: projectId,
		Id:        channelId,
		Name:      name,
		Port:      int(port),
		Host:      host,
		Raw:       raw,
	}
	channel.connect()
	channels[channelId] = channel
	go channel.start()
	return channelId
}

func Send(
	channelId string,
	data []byte,
) {
	channel, ok := channels[channelId]
	if !ok {
		return
	}
	channel.send(data)
}
