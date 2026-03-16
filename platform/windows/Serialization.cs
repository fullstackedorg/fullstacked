using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Linq;
using System.Text;


//const (
//    UNDEFINED SerializableDataType = 0
//    BOOLEAN   SerializableDataType = 1
//    STRING    SerializableDataType = 2
//    NUMBER    SerializableDataType = 3
//    BUFFER    SerializableDataType = 4
//    OBJECT    SerializableDataType = 5
//)

enum SerializableDataType : byte
{
    UNDEFINED = 0,
    BOOLEAN = 1,
    STRING = 2,
    NUMBER = 3,
    BUFFER = 4,
    OBJECT = 5
}

namespace FullStacked
{
    public class DataValue
    {
        public string str;
        public byte[] buffer;
    }

    internal class Serialization
    {
        public static byte[] NumberToUint4Bytes(int num)
        {
            byte[] bytes = new byte[4];
            bytes[0] = (byte)((num & 0xff000000) >> 24);
            bytes[1] = (byte)((num & 0x00ff0000) >> 16);
            bytes[2] = (byte)((num & 0x0000ff00) >> 8);
            bytes[3] = (byte)((num & 0x000000ff) >> 0);
            return bytes;
        }
        public static int Uint4BytesToNumber(byte[] bytes)
        {
            uint value = 0;
            foreach (byte b in bytes)
            {
                value = value << 8;
                value = value | b;
            }
            return (int)value;
        }

        public static (string, int) deserializeString(byte[] buffer, int index)
        {
            Range sizeRange = new(index + 1, index + 5);
            int size = Uint4BytesToNumber(buffer[sizeRange]);
            Range strRange = new(index + 5, index + 5 + size);
            string str = Encoding.UTF8.GetString(buffer[strRange]);
            return (str, size + 5);
        }

        public static (byte[], int) deserializeBuffer(byte[] buffer, int index)
        {
            Range sizeRange = new(index + 1, index + 5);
            int size = Uint4BytesToNumber(buffer[sizeRange]);
            Range bufRange = new(index + 5, index + 5 + size);
            return (buffer[bufRange], size + 5);
        }

        public static (DataValue, int) Deserialize(byte[] buffer, int index)
        {
            SerializableDataType dataType = (SerializableDataType)buffer[index];
            DataValue data = new();
            int size = 0;
            switch (dataType)
            {
                case SerializableDataType.UNDEFINED:
                case SerializableDataType.BOOLEAN:
                case SerializableDataType.NUMBER:
                case SerializableDataType.OBJECT:
                    Debug.WriteLine("Not implemented");
                    break;
                case SerializableDataType.STRING:
                    string str;
                    (str, size) = deserializeString(buffer, index);
                    data.str = str;
                    break;
                case SerializableDataType.BUFFER:
                    byte[] buf;
                    (buf, size) = deserializeBuffer(buffer, index);
                    data.buffer = buf;
                    break;
            }

            return (data, size);
        }


        public static List<DataValue> DeserializeAll(byte[] buffer)
        {

            List<DataValue> data = [];
            if (buffer == null)
            {
                return data;
            }
            int index = 0;
            while (index < buffer.Length)
            {
                DataValue deserialized;
                int size;
                (deserialized, size) = Deserialize(buffer, index);
                index += size;
                data.Add(deserialized);
            }
            return data;
        }

        public static byte[] MergeBuffers(byte[][] buffers)
        {
            byte[] combined = new byte[buffers.Sum(x =>
            {
                if (x == null)
                {
                    return 0;
                }
                return x.Length;
            })];
            int offset = 0;
            foreach (byte[] buffer in buffers)
            {
                if (buffer == null)
                {
                    continue;
                }
                Array.Copy(buffer, 0, combined, offset, buffer.Length);
                offset += buffer.Length;
            }
            return combined;
        }

        public static void PrintByteArray(byte[] bytes)
        {
            var sb = new StringBuilder("new byte[] { ");
            foreach (var b in bytes)
            {
                sb.Append(b + ", ");
            }
            sb.Append("}");
            Debug.WriteLine(sb.ToString());
        }

    }
}
