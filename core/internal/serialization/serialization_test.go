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
		if !slices.Equal(serialized, buf) || err != nil {
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
	_, _, err = DeserializeUndefined([]byte{}, 0)
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
	_, _, err = DeserializeString([]byte{UNDEFINED, 0, 0, 0, 0}, 0)
	if err == nil {
		t.Errorf(`Failed String`)
	}
	_, _, err = DeserializeString([]byte{STRING, 0}, 0)
	if err == nil {
		t.Errorf(`Failed String`)
	}
	_, _, err = DeserializeString([]byte{STRING, 0, 0, 0, 1}, 0)
	if err == nil {
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
	_, _, err = DeserializeNumber([]byte{NUMBER, 0}, 0)
	if err == nil {
		t.Errorf(`Failed Number`)
	}
	_, _, err = DeserializeNumber([]byte{STRING, 0, 0, 0, 0, 0, 0, 0, 0}, 0)
	if err == nil {
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
	if !slices.Equal(value, deserialized) || size != len(serialized) || err != nil {
		t.Errorf(`Failed Buffer`)
	}
	_, _, err = DeserializeBuffer([]byte{UNDEFINED, 0, 0, 0, 0}, 0)
	if err == nil {
		t.Errorf(`Failed Buffer`)
	}
	_, _, err = DeserializeBuffer([]byte{BUFFER, 0}, 0)
	if err == nil {
		t.Errorf(`Failed Buffer`)
	}
	_, _, err = DeserializeBuffer([]byte{BUFFER, 0, 0, 0, 1}, 0)
	if err == nil {
		t.Errorf(`Failed Buffer`)
	}
}

type Test struct {
	Foo      string
	Bar      int
	Nested   TestNest
	Cricular *Test
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
	value.Cricular = &value
	_, err = SerializeObject(value)
	if err == nil {
		t.Errorf(`Failed Object`)
	}
	_, _, err = DeserializeObject([]byte{}, 0)
	if err == nil {
		t.Errorf(`Failed Object`)
	}
	_, _, err = DeserializeObject([]byte{UNDEFINED, 0, 0, 0, 0}, 0)
	if err == nil {
		t.Errorf(`Failed Object`)
	}
	_, _, err = DeserializeObject([]byte{OBJECT, 0, 0, 0, 1}, 0)
	if err == nil {
		t.Errorf(`Failed Object`)
	}
}

func TestSerialize(t *testing.T) {
	value := (any)(nil)
	serialized := SerializeUndefined()
	test, err := Serialize(value)
	if !slices.Equal(test, serialized) || err != nil {
		t.Errorf(`Failed Serialize`)
	}

	value = false
	serialized = SerializeBoolean(value.(bool))
	test, err = Serialize(value)
	if !slices.Equal(test, serialized) || err != nil {
		t.Errorf(`Failed Serialize`)
	}

	value = 1.1
	serialized = SerializeNumber(value.(float64))
	test, err = Serialize(value)
	if !slices.Equal(test, serialized) || err != nil {
		t.Errorf(`Failed Serialize`)
	}

	value = "test"
	serialized, _ = SerializeString(value.(string))
	test, err = Serialize(value)
	if !slices.Equal(test, serialized) || err != nil {
		t.Errorf(`Failed Serialize`)
	}

	value = []byte{1, 2, 3, 4}
	serialized, _ = SerializeBuffer(value.([]byte))
	test, err = Serialize(value)
	if !slices.Equal(test, serialized) || err != nil {
		t.Errorf(`Failed Serialize`)
	}

	value = Test{Foo: "test"}
	serialized, _ = SerializeObject(value)
	test, err = Serialize(value)
	if !slices.Equal(test, serialized) || err != nil {
		t.Errorf(`Failed Serialize`)
	}
}

func TestMergeBuffers(t *testing.T) {
	_, err := MergeBuffers(nil)
	if err == nil {
		t.Errorf(`Failed MergeBuffers`)
	}

	_, err = MergeBuffers([][]byte{{}, nil})
	if err == nil {
		t.Errorf(`Failed MergeBuffers`)
	}

	merged, err := MergeBuffers([][]byte{{1}, {2}, {3}, {4}})
	if !slices.Equal(merged, []byte{1, 2, 3, 4}) || err != nil {
		t.Errorf(`Failed MergeBuffers`)
	}
}

func TestDeserializeData(t *testing.T) {
	_, _, err := deserializeData([]byte{}, 0)
	if err == nil {
		t.Errorf(`Failed deserializeData`)
	}
	_, _, err = deserializeData([]byte{10}, 0)
	if err == nil {
		t.Errorf(`Failed deserializeData`)
	}

	value := (any)(nil)
	serialized, _ := Serialize(value)
	deserialized, _, err := deserializeData(serialized, 0)
	if deserialized != value || err != nil {
		t.Errorf(`Failed deserializeData`)
	}

	value = false
	serialized, _ = Serialize(value)
	deserialized, _, err = deserializeData(serialized, 0)
	if deserialized != value || err != nil {
		t.Errorf(`Failed deserializeData`)
	}

	value = 1.1
	serialized, _ = Serialize(value)
	deserialized, _, err = deserializeData(serialized, 0)
	if deserialized != value || err != nil {
		t.Errorf(`Failed deserializeData`)
	}

	value = "test"
	serialized, _ = Serialize(value)
	deserialized, _, err = deserializeData(serialized, 0)
	if deserialized != value || err != nil {
		t.Errorf(`Failed deserializeData`)
	}

	value = []byte{1, 2, 3, 4}
	serialized, _ = Serialize(value)
	deserialized, _, err = deserializeData(serialized, 0)
	if !slices.Equal(value.([]byte), deserialized.([]byte)) || err != nil {
		t.Errorf(`Failed deserializeData`)
	}

	value = Test{Foo: "test"}
	serialized, _ = Serialize(value)
	deserialized, _, err = deserializeData(serialized, 0)
	obj := Test{}
	json.Unmarshal(deserialized.(Object).Data, &obj)
	if obj.Foo != value.(Test).Foo || err != nil {
		t.Errorf(`Failed deserializeData`)
	}

}

func TestDeserialize(t *testing.T) {
	_, err := Deserialize(nil)
	if err == nil {
		t.Errorf(`Failed Deserialize`)
	}
	_, err = Deserialize([]byte{1})
	if err == nil {
		t.Errorf(`Failed Deserialize`)
	}

	values := []any{nil, false, 1.1, "test", []byte{1, 2, 3, 4}, Test{Foo: "test"}}
	serializedValues := [][]byte{}
	for _, v := range values {
		serialized, err := Serialize(v)
		if err != nil {
			t.Errorf(`Failed Deserialize`)
		}
		serializedValues = append(serializedValues, serialized)
	}
	merged, err := MergeBuffers(serializedValues)
	if err != nil {
		t.Errorf(`Failed Deserialize`)
	}

	deserialized, err := Deserialize(merged)
	if err != nil {
		t.Errorf(`Failed Deserialize`)
	}

	if len(deserialized) != len(values) {
		t.Errorf(`Failed Deserialize`)
	}

	if deserialized[0] != values[0] {
		t.Errorf(`Failed Deserialize`)
	}

	if deserialized[1].(bool) != values[1].(bool) {
		t.Errorf(`Failed Deserialize`)
	}

	if deserialized[2].(float64) != values[2].(float64) {
		t.Errorf(`Failed Deserialize`)
	}

	if deserialized[3].(string) != values[3].(string) {
		t.Errorf(`Failed Deserialize`)
	}

	if !slices.Equal(deserialized[4].([]byte), values[4].([]byte)) {
		t.Errorf(`Failed Deserialize`)
	}

	obj := Test{}
	json.Unmarshal(deserialized[5].(Object).Data, &obj)
	if obj.Foo != values[5].(Test).Foo {
		t.Errorf(`Failed Deserialize`)
	}
}
