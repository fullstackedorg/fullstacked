
#include "./utils.h"
#include <iostream>
#include <string.h>
#include <string>
#include <algorithm>
#include <cctype>
#include <functional>
#include <iostream>

char *numberToByte(int number)
{
    char *bytes = new char[4];
    bytes[0] = ((number & 0xff000000) >> 24);
    bytes[1] = ((number & 0x00ff0000) >> 16);
    bytes[2] = ((number & 0x0000ff00) >> 8);
    bytes[3] = ((number & 0x000000ff) >> 0);
    return bytes;
}

unsigned bytesToNumber(unsigned char *bytes, int size)
{
    unsigned value = 0;
    for (int i = 0; i < size; i++)
    {
        value = value << 8;
        value = value | (unsigned)bytes[i];
    }
    return value;
}

int deserializeNumber(char *bytes, int size)
{
    bool negative = bytes[0] == 1;

    unsigned n = 0;
    int i = 1;
    while (i <= size)
    {
        n += ((unsigned)bytes[i]) << ((i - 1) * 8);
        i += 1;
    }

    int value = (int)n;

    if (negative)
    {
        return 0 - value;
    }

    return value;
}

void printBuffer(char *buffer, int size)
{
    for (int i = 0; i < size; i++)
    {
        std::cout << (int)buffer[i] << " ";
    }
    std::cout << std::endl;
}

int combineBuffers(char *buf1, int lgt1, char *buf2, int lgt2, char *result)
{
    int combinedLength = lgt1 + lgt2;
    char *combined = new char[combinedLength];
    for (int i = 0; i < lgt1; i++)
    {
        combined[i] = buf1[i];
    }
    for (int i = 0; i < lgt2; i++)
    {
        combined[i + lgt1] = buf2[i];
    }
    memcpy(result, combined, combinedLength);
    free(combined);
    return combinedLength;
}

std::vector<DataValue> deserializeArgs(std::vector<unsigned char> data)
{
    std::vector<DataValue> args;

    int cursor = 0;

    while (cursor < data.size())
    {
        DataType type = (DataType)data.at(cursor);

        cursor++;
        std::vector<unsigned char> lengthData(data.begin() + cursor, data.begin() + cursor + 4);
        int length = bytesToNumber(reinterpret_cast<unsigned char *>(lengthData.data()), 4);

        cursor += 4;
        std::vector<unsigned char> arg(data.begin() + cursor, data.begin() + cursor + length);
        cursor += length;

        DataValue v = *(new DataValue());
        switch (type)
        {
        case UNDEFINED:
            break;
        case BOOLEAN:
            v.boolean = arg.at(0) == 1 ? true : false;
            break;
        case NUMBER:
            v.number = deserializeNumber(reinterpret_cast<char *>(arg.data()), length);
            break;
        case STRING:
            v.str = std::string(reinterpret_cast<char *>(arg.data()), length);
            break;
        case BUFFER:
            v.buffer = arg;
            break;
        default:
            break;
        }
        args.push_back(v);
    }

    return args;
}

std::string gen_random(const int len)
{
    static const char alphanum[] =
        "ABCDEFGHIJKLMNOPQRSTUVWXYZ"
        "abcdefghijklmnopqrstuvwxyz";
    std::string tmp_s;
    tmp_s.reserve(len);

    for (int i = 0; i < len; ++i)
    {
        tmp_s += alphanum[rand() % (sizeof(alphanum) - 1)];
    }

    return tmp_s;
}

// source: https://stackoverflow.com/a/4823686
std::string uri_decode(std::string str)
{
    std::string ret;
    char ch;
    int i, ii;
    for (i = 0; i < str.length(); i++)
    {
        if (str[i] == '%')
        {
            sscanf(str.substr(i + 1, 2).c_str(), "%x", &ii);
            ch = static_cast<char>(ii);
            ret += ch;
            i = i + 2;
        }
        else
        {
            ret += str[i];
        }
    }
    return (ret);
}

// source: https://gist.github.com/RedCarrottt/c7a056695e6951415a0368a87ad1e493
void URL::parse(const std::string &url_s)
{
    const std::string prot_end("://");
    std::string::const_iterator prot_i = std::search(url_s.begin(), url_s.end(),
                                                     prot_end.begin(), prot_end.end());
    protocol.reserve(distance(url_s.begin(), prot_i));
    std::transform(url_s.begin(), prot_i,
                   std::back_inserter(protocol),
                   std::function(tolower)); // protocol is icase
    if (prot_i == url_s.end())
        return;
    std::advance(prot_i, prot_end.length());
    std::string::const_iterator path_i = std::find(prot_i, url_s.end(), '/');
    host.reserve(distance(prot_i, path_i));
    std::transform(prot_i, path_i,
              std::back_inserter(host),
              std::function(tolower)); // host is icase
    std::string::const_iterator query_i = find(path_i, url_s.end(), '?');
    path.assign(path_i, query_i);
    if (query_i != url_s.end())
        ++query_i;
    query.assign(query_i, url_s.end());
}


std::string URL::str(){
    std::string str = protocol + "://" + host + path;

    if(!query.empty()) {
        str += "?" + query;
    }

    return str;
}