package dns

import (
	"errors"
	"fullstackedorg/fullstacked/types"
	"net"
	"strings"
)

type DnsFn = uint8

const (
	Resolve4     DnsFn = 0
	Resolve6     DnsFn = 1
	ResolveCNAME DnsFn = 2
	ResolveMX    DnsFn = 3
	ResolveNS    DnsFn = 4
	ResolveSRV   DnsFn = 5
	ResolveTXT   DnsFn = 6
)

func Switch(
	ctx *types.CoreCallContext,
	header types.CoreCallHeader,
	data []types.DeserializedData,
	response *types.CoreCallResponse,
) error {
	err := (error)(nil)
	switch header.Fn {
	case Resolve4:
		ipv4, err := resolve4(data[0].Data.(string))
		if err == nil {
			response.Data = ipv4
		}
	case Resolve6:
		ipv6, err := resolve6(data[0].Data.(string))
		if err == nil {
			response.Data = ipv6
		}
	case ResolveCNAME:
		cname, err := net.LookupCNAME(data[0].Data.(string))
		if err == nil {
			response.Data = []string{strings.TrimSuffix(cname, ".")}
		}
	case ResolveMX:
		mx, err := resolveMx(data[0].Data.(string))
		if err == nil {
			response.Data = mx
		}
	case ResolveNS:
		ns, err := net.LookupNS(data[0].Data.(string))
		if err == nil {
			nss := []string{}
			for _, r := range ns {
				nss = append(nss, strings.TrimSuffix(r.Host, "."))
			}
			response.Data = nss
		}
	case ResolveSRV:
		srv, err := resolveSrv(data[0].Data.(string))
		if err == nil {
			response.Data = srv
		}
	case ResolveTXT:
		txt, err := net.LookupTXT(data[0].Data.(string))
		if err == nil {
			response.Data = [][]string{txt}
		}
	default:
		err = errors.New("unknown dns function")
	}

	if err != nil {
		return err
	}

	response.Type = types.CoreResponseData
	return err
}

func resolve4(host string) ([]string, error) {
	ips, err := net.LookupIP(host)

	if err != nil {
		return nil, err
	}

	ipv4 := []string{}

	for _, ip := range ips {
		if len(ip) == net.IPv4len {
			ipv4 = append(ipv4, ip.String())
		}
	}

	return ipv4, nil
}

func resolve6(host string) ([]string, error) {
	ips, err := net.LookupIP(host)

	if err != nil {
		return nil, err
	}

	ipv6 := []string{}

	for _, ip := range ips {
		if len(ip) == net.IPv6len {
			ipv6 = append(ipv6, ip.String())
		}
	}

	return ipv6, nil
}

type MX struct {
	Exchange string `json:"exchange"`
	Priority uint16 `json:"priority"`
}

func resolveMx(host string) ([]MX, error) {
	mx, err := net.LookupMX(host)
	if err != nil {
		return nil, err
	}

	mxs := []MX{}

	for _, r := range mx {
		mxs = append(mxs, MX{
			Exchange: strings.TrimSuffix(r.Host, "."),
			Priority: r.Pref,
		})
	}

	return mxs, nil
}

type SRV struct {
	Name     string `json:"name"`
	Port     uint16 `json:"port"`
	Priority uint16 `json:"priority"`
	Weight   uint16 `json:"weight"`
}

func resolveSrv(host string) ([]SRV, error) {
	_, srv, err := net.LookupSRV("", "", host)
	if err != nil {
		return nil, err
	}

	srvs := []SRV{}
	for _, r := range srv {
		srvs = append(srvs, SRV{
			Name:     strings.TrimSuffix(r.Target, "."),
			Port:     r.Port,
			Priority: r.Priority,
			Weight:   r.Weight,
		})
	}

	return srvs, nil
}
