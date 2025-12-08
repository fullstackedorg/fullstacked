package fs

type FsFn = int

const (
	Mkdir = 0
)

func Switch(fn FsFn, payload []any) any {
	switch fn {
	case Mkdir:
		return mkdir(payload[0].(string), payload[1].(MkdirOptions))
	}

	return nil
}

type MkdirOptions struct {
	Recursive bool
}

func mkdir(path string, opts MkdirOptions) error {
	return nil
}
