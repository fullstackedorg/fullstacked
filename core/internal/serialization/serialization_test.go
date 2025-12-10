package serialization

import (
	"slices"
	"testing"
)

func TestUint4BytesToInt(t *testing.T) {
	testData := map[int][]byte{
		0:                {0, 0, 0, 0},
		1:                {0, 0, 0, 1},
		256:              {0, 0, 1, 0},
		65536:            {0, 1, 0, 0},
		16777216:         {1, 0, 0, 0},
		MAX_UINT_4_BYTES: {255, 255, 255, 255},
	}

	for v, buf := range testData {
		serialized, err := NumberToUin4Bytes(v)
		if slices.Compare(serialized, buf) != 0 || err != nil {
			t.Errorf(`Failed Uint4BytesToInt`)
		}
		deserialized, err := Uint4BytesToNumber(serialized)
		if deserialized != v || err != nil {
			t.Errorf(`Failed Uint4BytesToInt`)
		}
	}

	_, err := Uint4BytesToNumber(nil)
	if err == nil {
		t.Errorf(`Failed Uint4BytesToInt`)
	}
	_, err = Uint4BytesToNumber([]byte{0})
	if err == nil {
		t.Errorf(`Failed Uint4BytesToInt`)
	}
	_, err = NumberToUin4Bytes(-1)
	if err == nil {
		t.Errorf(`Failed Uint4BytesToInt`)
	}
	_, err = NumberToUin4Bytes(MAX_UINT_4_BYTES + 1)
	if err == nil {
		t.Errorf(`Failed Uint4BytesToInt`)
	}
}

func TestUndefined(t *testing.T) {
	value := (any)(nil)
	serialized := SerializeUndefined()
	deserialized, err := DeserializeUndefined(serialized)
	if deserialized != value || err != nil {
		t.Errorf(`Failed Undefined`)
	}
	_, err = DeserializeUndefined([]byte{BOOLEAN})
	if err == nil {
		t.Errorf(`Failed Undefined`)
	}
	_, err = DeserializeUndefined([]byte{UNDEFINED, 0})
	if err == nil {
		t.Errorf(`Failed Undefined`)
	}
}

func TestBoolean(t *testing.T) {
	value := false
	serialized := SerializeBoolean(value)
	deserialized, err := DeserializeBoolean(serialized)
	if deserialized != value || err != nil {
		t.Errorf(`Failed Boolean`)
	}
	value, err = DeserializeBoolean(SerializeBoolean(true))
	if !value {
		t.Errorf(`Failed Boolean`)
	}
	_, err = DeserializeBoolean([]byte{BOOLEAN})
	if err == nil {
		t.Errorf(`Failed Boolean`)
	}
	_, err = DeserializeBoolean([]byte{UNDEFINED, 0})
	if err == nil {
		t.Errorf(`Failed Boolean`)
	}
}
