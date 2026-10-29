package dns

import (
	"context"
	"errors"
	"fullstackedorg/fullstacked/internal/tunnel"
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
	Lookup       DnsFn = 7
)

var customResolver *net.Resolver

func getResolver() *net.Resolver {
	if customResolver == nil {
		// Google DNS server
		dnsServer := "8.8.8.8:53"

		customResolver = &net.Resolver{
			PreferGo: true,
			Dial: func(ctx context.Context, network, address string) (net.Conn, error) {
				d := net.Dialer{}
				return d.DialContext(ctx, "udp", dnsServer)
			},
		}
	}

	return customResolver
}

func Switch(
	ctx *types.Context,
	header types.CoreCallHeader,
	data []types.DeserializedData,
	response *types.CoreCallResponse,
) error {
	err := (error)(nil)
	resData := (types.SerializableData)(nil)

	host := data[0].Data.(string)
	if t := tunnel.FindTunnel(host); t != nil {
		host = t.Host
	}

	switch header.Fn {
	case Resolve4:
		resData, err = resolve4(host)
	case Resolve6:
		resData, err = resolve6(host)
	case ResolveCNAME:
		cname, err2 := getResolver().LookupCNAME(context.Background(), host)
		resData = []string{strings.TrimSuffix(cname, ".")}
		err = err2
	case ResolveMX:
		resData, err = resolveMx(host)
	case ResolveNS:
		ns, err2 := getResolver().LookupNS(context.Background(), host)
		nss := []string{}
		for _, r := range ns {
			nss = append(nss, strings.TrimSuffix(r.Host, "."))
		}
		resData = nss
		err = err2
	case ResolveSRV:
		resData, err = resolveSrv(host)
	case ResolveTXT:
		txt, err2 := getResolver().LookupTXT(context.Background(), host)
		resData = [][]string{txt}
		err = err2
	case Lookup:
		resData, err = lookup(host)
	default:
		err = errors.New("unknown dns function")
	}

	if err != nil {
		return err
	}

	response.Type = types.CoreResponseData
	response.Data = resData
	return err
}

func resolve4(host string) ([]string, error) {
	ips, err := getResolver().LookupIP(context.Background(), "ip", host)

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
	ips, err := getResolver().LookupIP(context.Background(), "ip", host)

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
	Type     string `json:"type"`
}

func resolveMx(host string) ([]MX, error) {
	mx, err := getResolver().LookupMX(context.Background(), host)
	if err != nil {
		return nil, err
	}

	mxs := []MX{}

	for _, r := range mx {
		mxs = append(mxs, MX{
			Exchange: strings.TrimSuffix(r.Host, "."),
			Priority: r.Pref,
			Type:     "MX",
		})
	}

	return mxs, nil
}

type SRV struct {
	Name     string `json:"name"`
	Port     uint16 `json:"port"`
	Priority uint16 `json:"priority"`
	Weight   uint16 `json:"weight"`
	Type     string `json:"type"`
}

func resolveSrv(host string) ([]SRV, error) {
	_, srv, err := getResolver().LookupSRV(context.Background(), "", "", host)
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
			Type:     "SRV",
		})
	}

	return srvs, nil
}

type LookupResult struct {
	Address string `json:"address"`
	Family  int    `json:"family"`
}

func lookup(host string) ([]LookupResult, error) {
	ips, err := net.LookupIP(host)
	if err != nil {
		return nil, err
	}

	results := []LookupResult{}
	for _, ip := range ips {
		family := 4
		if ip.To4() == nil {
			family = 6
		}
		results = append(results, LookupResult{
			Address: ip.String(),
			Family:  family,
		})
	}

	return results, nil
}
