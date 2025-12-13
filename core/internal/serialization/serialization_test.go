package serialization

import (
	"encoding/json"
	"fullstackedorg/fullstacked/types"
	"slices"
	"testing"
)

func TestUint4BytesToInt(t *testing.T) {
	testData := map[int][]byte{
		0:                      {0, 0, 0, 0},
		1:                      {0, 0, 0, 1},
		256:                    {0, 0, 1, 0},
		65536:                  {0, 1, 0, 0},
		16777216:               {1, 0, 0, 0},
		types.MAX_UINT_4_BYTES: {255, 255, 255, 255},
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
	_, err = NumberToUin4Bytes(types.MAX_UINT_4_BYTES + 1)
	if err == nil {
		t.Errorf(`Failed Uint4BytesToInt`)
	}
}

func TestUndefined(t *testing.T) {
	value := (any)(nil)
	serialized := serializeUndefined()
	deserialized, size, err := deserializeUndefined(serialized, 0)
	if deserialized != value || size != len(serialized) || err != nil {
		t.Errorf(`Failed Undefined`)
	}
	_, _, err = deserializeUndefined([]byte{types.BOOLEAN}, 0)
	if err == nil {
		t.Errorf(`Failed Undefined`)
	}
	_, _, err = deserializeUndefined([]byte{}, 0)
	if err == nil {
		t.Errorf(`Failed Undefined`)
	}
}

func TestBoolean(t *testing.T) {
	value := false
	serialized := serializeBoolean(value)
	deserialized, size, err := deserializeBoolean(serialized, 0)
	if deserialized != value || size != len(serialized) || err != nil {
		t.Errorf(`Failed Boolean`)
	}
	value, _, err = deserializeBoolean(serializeBoolean(true), 0)
	if !value {
		t.Errorf(`Failed Boolean`)
	}
	_, _, err = deserializeBoolean([]byte{types.BOOLEAN}, 0)
	if err == nil {
		t.Errorf(`Failed Boolean`)
	}
	_, _, err = deserializeBoolean([]byte{types.BOOLEAN, 2}, 0)
	if err == nil {
		t.Errorf(`Failed Boolean`)
	}
	_, _, err = deserializeBoolean([]byte{types.UNDEFINED, 0}, 0)
	if err == nil {
		t.Errorf(`Failed Boolean`)
	}
}

func TestString(t *testing.T) {
	value := "test"
	serialized, err := serializeString(value)
	if err != nil {
		t.Errorf(`Failed String`)
	}
	deserialized, size, err := deserializeString(serialized, 0)
	if deserialized != value || size != len(serialized) || err != nil {
		t.Errorf(`Failed String`)
	}
	_, _, err = deserializeString([]byte{types.UNDEFINED, 0, 0, 0, 0}, 0)
	if err == nil {
		t.Errorf(`Failed String`)
	}
	_, _, err = deserializeString([]byte{types.STRING, 0}, 0)
	if err == nil {
		t.Errorf(`Failed String`)
	}
	_, _, err = deserializeString([]byte{types.STRING, 0, 0, 0, 1}, 0)
	if err == nil {
		t.Errorf(`Failed String`)
	}
}

func TestNumber(t *testing.T) {
	value := 12.0
	serialized := serializeNumber(value)
	deserialized, size, err := deserializeNumber(serialized, 0)
	if deserialized != value || size != len(serialized) || err != nil {
		t.Errorf(`Failed Number`)
	}
	_, _, err = deserializeNumber([]byte{types.NUMBER, 0}, 0)
	if err == nil {
		t.Errorf(`Failed Number`)
	}
	_, _, err = deserializeNumber([]byte{types.STRING, 0, 0, 0, 0, 0, 0, 0, 0}, 0)
	if err == nil {
		t.Errorf(`Failed Number`)
	}
}

func TestBuffer(t *testing.T) {
	value := []byte{1, 2, 3, 4}
	serialized, err := serializeBuffer(value)
	if err != nil {
		t.Errorf(`Failed Buffer`)
	}
	deserialized, size, err := deserializeBuffer(serialized, 0)
	if !slices.Equal(value, deserialized) || size != len(serialized) || err != nil {
		t.Errorf(`Failed Buffer`)
	}
	_, _, err = deserializeBuffer([]byte{types.UNDEFINED, 0, 0, 0, 0}, 0)
	if err == nil {
		t.Errorf(`Failed Buffer`)
	}
	_, _, err = deserializeBuffer([]byte{types.BUFFER, 0}, 0)
	if err == nil {
		t.Errorf(`Failed Buffer`)
	}
	_, _, err = deserializeBuffer([]byte{types.BUFFER, 0, 0, 0, 1}, 0)
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
	serialized, err := serializeObject(value)
	if err != nil {
		t.Errorf(`Failed Object`)
	}
	deserialized, size, err := deserializeObject(serialized, 0)
	deserializedObj := Test{}
	json.Unmarshal(deserialized.Data, &deserializedObj)
	if deserializedObj.Nested.Baz != value.Nested.Baz || size != len(serialized) || err != nil {
		t.Errorf(`Failed Object`)
	}
	value.Cricular = &value
	_, err = serializeObject(value)
	if err == nil {
		t.Errorf(`Failed Object`)
	}
	_, _, err = deserializeObject([]byte{}, 0)
	if err == nil {
		t.Errorf(`Failed Object`)
	}
	_, _, err = deserializeObject([]byte{types.UNDEFINED, 0, 0, 0, 0}, 0)
	if err == nil {
		t.Errorf(`Failed Object`)
	}
	_, _, err = deserializeObject([]byte{types.OBJECT, 0, 0, 0, 1}, 0)
	if err == nil {
		t.Errorf(`Failed Object`)
	}
}

func TestSerialize(t *testing.T) {
	value := (any)(nil)
	serialized := serializeUndefined()
	test, err := Serialize(value)
	if !slices.Equal(test, serialized) || err != nil {
		t.Errorf(`Failed Serialize`)
	}

	value = false
	serialized = serializeBoolean(value.(bool))
	test, err = Serialize(value)
	if !slices.Equal(test, serialized) || err != nil {
		t.Errorf(`Failed Serialize`)
	}

	value = 1.1
	serialized = serializeNumber(value.(float64))
	test, err = Serialize(value)
	if !slices.Equal(test, serialized) || err != nil {
		t.Errorf(`Failed Serialize`)
	}

	value = "test"
	serialized, _ = serializeString(value.(string))
	test, err = Serialize(value)
	if !slices.Equal(test, serialized) || err != nil {
		t.Errorf(`Failed Serialize`)
	}

	value = []byte{1, 2, 3, 4}
	serialized, _ = serializeBuffer(value.([]byte))
	test, err = Serialize(value)
	if !slices.Equal(test, serialized) || err != nil {
		t.Errorf(`Failed Serialize`)
	}

	value = Test{Foo: "test"}
	serialized, _ = serializeObject(value)
	test, err = Serialize(value)
	if !slices.Equal(test, serialized) || err != nil {
		t.Errorf(`Failed Serialize`)
	}
}

func TestMergeBuffers(t *testing.T) {
	_, err := MergeBuffers(nil)
	if err == nil {
		t.Errorf(`Failed mergeBuffers`)
	}

	_, err = MergeBuffers([][]byte{{}, nil})
	if err == nil {
		t.Errorf(`Failed mergeBuffers`)
	}

	merged, err := MergeBuffers([][]byte{{1}, {2}, {3}, {4}})
	if !slices.Equal(merged, []byte{1, 2, 3, 4}) || err != nil {
		t.Errorf(`Failed mergeBuffers`)
	}
}

func TestDeserializeData(t *testing.T) {
	_, err := Deserialize([]byte{}, 0)
	if err == nil {
		t.Errorf(`Failed deserializeData`)
	}
	_, err = Deserialize([]byte{10}, 0)
	if err == nil {
		t.Errorf(`Failed deserializeData`)
	}

	value := (any)(nil)
	serialized, _ := Serialize(value)
	deserialized, err := Deserialize(serialized, 0)
	if deserialized.Data != value || deserialized.Type != types.UNDEFINED || err != nil {
		t.Errorf(`Failed deserializeData`)
	}

	value = false
	serialized, _ = Serialize(value)
	deserialized, err = Deserialize(serialized, 0)
	if deserialized.Data != value || deserialized.Type != types.BOOLEAN || err != nil {
		t.Errorf(`Failed deserializeData`)
	}

	value = 1.1
	serialized, _ = Serialize(value)
	deserialized, err = Deserialize(serialized, 0)
	if deserialized.Data != value || deserialized.Type != types.NUMBER || err != nil {
		t.Errorf(`Failed deserializeData`)
	}

	value = "test"
	serialized, _ = Serialize(value)
	deserialized, err = Deserialize(serialized, 0)
	if deserialized.Data != value || deserialized.Type != types.STRING || err != nil {
		t.Errorf(`Failed deserializeData`)
	}

	value = []byte{1, 2, 3, 4}
	serialized, _ = Serialize(value)
	deserialized, err = Deserialize(serialized, 0)
	if !slices.Equal(value.([]byte), deserialized.Data.([]byte)) || deserialized.Type != types.BUFFER || err != nil {
		t.Errorf(`Failed deserializeData`)
	}

	value = Test{Foo: "test"}
	serialized, _ = Serialize(value)
	deserialized, err = Deserialize(serialized, 0)
	obj := Test{}
	json.Unmarshal(deserialized.Data.(types.DeserializedRawObject).Data, &obj)
	if obj.Foo != value.(Test).Foo || deserialized.Type != types.OBJECT || err != nil {
		t.Errorf(`Failed deserializeData`)
	}

}

func TestDeserialize(t *testing.T) {
	_, err := DeserializeAll(nil)
	if err == nil {
		t.Errorf(`Failed Deserialize`)
	}
	_, err = DeserializeAll([]byte{1})
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

	deserialized, err := DeserializeAll(merged)
	if err != nil {
		t.Errorf(`Failed Deserialize`)
	}

	if len(deserialized) != len(values) {
		t.Errorf(`Failed Deserialize`)
	}

	if deserialized[0].Data != values[0] {
		t.Errorf(`Failed Deserialize`)
	}

	if deserialized[1].Data.(bool) != values[1].(bool) {
		t.Errorf(`Failed Deserialize`)
	}

	if deserialized[2].Data.(float64) != values[2].(float64) {
		t.Errorf(`Failed Deserialize`)
	}

	if deserialized[3].Data.(string) != values[3].(string) {
		t.Errorf(`Failed Deserialize`)
	}

	if !slices.Equal(deserialized[4].Data.([]byte), values[4].([]byte)) {
		t.Errorf(`Failed Deserialize`)
	}

	obj := Test{}
	json.Unmarshal(deserialized[5].Data.(types.DeserializedRawObject).Data, &obj)
	if obj.Foo != values[5].(Test).Foo {
		t.Errorf(`Failed Deserialize`)
	}
}
