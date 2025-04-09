#ifndef UTILS_H
#define UTILS_H

#include <vector>
#include <string>

char *numberToByte(int number);

unsigned bytesToNumber(unsigned char *bytes, int size);

int deserializeNumber(char *bytes, int size);

void printBuffer(char *buffer, int size);

int combineBuffers(char *buf1, int lgt1, char *buf2, int lgt2, char *result);

class DataValue
{
public:
    bool boolean;
    std::string str;
    int number;
    std::vector<unsigned char> buffer;
};

enum DataType
{
    UNDEFINED = 0,
    BOOLEAN = 1,
    STRING = 2,
    NUMBER = 3,
    BUFFER = 4
};

std::vector<DataValue> deserializeArgs(std::vector<unsigned char> data);

#endif