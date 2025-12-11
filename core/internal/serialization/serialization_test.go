package serialization

import (
	"encoding/json"
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
	deserialized, size, err := DeserializeUndefined(serialized, 0)
	if deserialized != value || size != len(serialized) || err != nil {
		t.Errorf(`Failed Undefined`)
	}
	_, _, err = DeserializeUndefined([]byte{BOOLEAN}, 0)
	if err == nil {
		t.Errorf(`Failed Undefined`)
	}
}

func TestBoolean(t *testing.T) {
	value := false
	serialized := SerializeBoolean(value)
	deserialized, size, err := DeserializeBoolean(serialized, 0)
	if deserialized != value || size != len(serialized) || err != nil {
		t.Errorf(`Failed Boolean`)
	}
	value, _, err = DeserializeBoolean(SerializeBoolean(true), 0)
	if !value {
		t.Errorf(`Failed Boolean`)
	}
	_, _, err = DeserializeBoolean([]byte{BOOLEAN}, 0)
	if err == nil {
		t.Errorf(`Failed Boolean`)
	}
	_, _, err = DeserializeBoolean([]byte{BOOLEAN, 2}, 0)
	if err == nil {
		t.Errorf(`Failed Boolean`)
	}
	_, _, err = DeserializeBoolean([]byte{UNDEFINED, 0}, 0)
	if err == nil {
		t.Errorf(`Failed Boolean`)
	}
}

func TestString(t *testing.T) {
	value := "test"
	serialized, err := SerializeString(value)
	if err != nil {
		t.Errorf(`Failed String`)
	}
	deserialized, size, err := DeserializeString(serialized, 0)
	if deserialized != value || size != len(serialized) || err != nil {
		t.Errorf(`Failed String`)
	}
}

func TestNumber(t *testing.T) {
	value := 12.0
	serialized := SerializeNumber(value)
	deserialized, size, err := DeserializeNumber(serialized, 0)
	if deserialized != value || size != len(serialized) || err != nil {
		t.Errorf(`Failed Number`)
	}
}

func TestBuffer(t *testing.T) {
	value := []byte{1, 2, 3, 4}
	serialized, err := SerializeBuffer(value)
	if err != nil {
		t.Errorf(`Failed Buffer`)
	}
	deserialized, size, err := DeserializeBuffer(serialized, 0)
	if slices.Compare(value, deserialized) != 0 || size != len(serialized) || err != nil {
		t.Errorf(`Failed Buffer`)
	}
}

type Test struct {
	Foo    string
	Bar    int
	Nested TestNest
}

type TestNest struct {
	Baz string
}

func TestObject(t *testing.T) {
	value := Test{
		Foo: "foo",
		Bar: 2,
		Nested: TestNest{
			Baz: "bar",
		},
	}
	serialized, err := SerializeObject(value)
	if err != nil {
		t.Errorf(`Failed Object`)
	}
	deserialized, size, err := DeserializeObject(serialized, 0)
	deserializedObj := Test{}
	json.Unmarshal(deserialized.Data, &deserializedObj)
	if deserializedObj.Nested.Baz != value.Nested.Baz || size != len(serialized) || err != nil {
		t.Errorf(`Failed Object`)
	}
}
