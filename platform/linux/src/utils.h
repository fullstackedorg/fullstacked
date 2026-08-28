#ifndef UTILS_H
#define UTILS_H

#include <cstdint>
#include <string>
#include <vector>
#include <utility>

enum SerializableDataType : uint8_t {
    UNDEFINED = 0,
    BOOLEAN = 1,
    STRING = 2,
    NUMBER = 3,
    BUFFER = 4,
    OBJECT = 5
};

struct DataValue {
    SerializableDataType type = UNDEFINED;
    bool boolean = false;
    double number = 0;
    std::string str;
    std::vector<uint8_t> buffer;
};

uint32_t uint4BytesToNumber(const uint8_t *bytes);
void numberToUint4Bytes(uint32_t num, uint8_t *bytes);

std::pair<DataValue, int> deserialize(const std::vector<uint8_t> &buffer, size_t index);
std::vector<DataValue> deserializeAll(const std::vector<uint8_t> &buffer);
std::vector<uint8_t> mergeBuffers(const std::vector<std::vector<uint8_t>> &buffers);

std::string getExePath();
std::string getEditorDir();
void registerDesktopApp();
std::string gen_random(const int len);

#endif