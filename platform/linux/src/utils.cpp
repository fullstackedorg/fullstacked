#include "./utils.h"
#include <algorithm>
#include <cstring>
#include <filesystem>
#include <fstream>
#include <iostream>
#include <limits.h>
#include <unistd.h>

uint32_t uint4BytesToNumber(const uint8_t *bytes) {
    return (static_cast<uint32_t>(bytes[0]) << 24) |
           (static_cast<uint32_t>(bytes[1]) << 16) |
           (static_cast<uint32_t>(bytes[2]) << 8) |
           static_cast<uint32_t>(bytes[3]);
}

void numberToUint4Bytes(uint32_t num, uint8_t *bytes) {
    bytes[0] = static_cast<uint8_t>((num >> 24) & 0xff);
    bytes[1] = static_cast<uint8_t>((num >> 16) & 0xff);
    bytes[2] = static_cast<uint8_t>((num >> 8) & 0xff);
    bytes[3] = static_cast<uint8_t>(num & 0xff);
}

std::pair<DataValue, int> deserialize(const std::vector<uint8_t> &buffer, size_t index) {
    DataValue val;
    if (index >= buffer.size()) {
        return {val, 0};
    }

    uint8_t typeByte = buffer[index];
    val.type = static_cast<SerializableDataType>(typeByte);

    switch (val.type) {
    case UNDEFINED:
        return {val, 1};

    case BOOLEAN:
        if (index + 1 < buffer.size()) {
            val.boolean = (buffer[index + 1] == 1);
        }
        return {val, 2};

    case STRING: {
        if (index + 5 > buffer.size()) {
            return {val, static_cast<int>(buffer.size() - index)};
        }
        uint32_t size = uint4BytesToNumber(&buffer[index + 1]);
        size_t start = index + 5;
        size_t end = std::min(start + size, buffer.size());
        val.str = std::string(reinterpret_cast<const char *>(&buffer[start]), end - start);
        return {val, static_cast<int>(5 + size)};
    }

    case NUMBER: {
        if (index + 9 > buffer.size()) {
            return {val, static_cast<int>(buffer.size() - index)};
        }
        uint64_t bits = 0;
        for (int i = 0; i < 8; i++) {
            bits = (bits << 8) | buffer[index + 1 + i];
        }
        double d;
        std::memcpy(&d, &bits, sizeof(double));
        val.number = d;
        return {val, 9};
    }

    case BUFFER: {
        if (index + 5 > buffer.size()) {
            return {val, static_cast<int>(buffer.size() - index)};
        }
        uint32_t size = uint4BytesToNumber(&buffer[index + 1]);
        size_t start = index + 5;
        size_t end = std::min(start + size, buffer.size());
        val.buffer = std::vector<uint8_t>(buffer.begin() + start, buffer.begin() + end);
        return {val, static_cast<int>(5 + size)};
    }

    case OBJECT: {
        if (index + 5 > buffer.size()) {
            return {val, static_cast<int>(buffer.size() - index)};
        }
        uint32_t size = uint4BytesToNumber(&buffer[index + 1]);
        size_t start = index + 5;
        size_t end = std::min(start + size, buffer.size());
        val.str = std::string(reinterpret_cast<const char *>(&buffer[start]), end - start);
        return {val, static_cast<int>(5 + size)};
    }

    default:
        return {val, 1};
    }
}

std::vector<DataValue> deserializeAll(const std::vector<uint8_t> &buffer) {
    std::vector<DataValue> data;
    size_t index = 0;
    while (index < buffer.size()) {
        auto [val, size] = deserialize(buffer, index);
        if (size <= 0) break;
        data.push_back(val);
        index += size;
    }
    return data;
}

std::vector<uint8_t> mergeBuffers(const std::vector<std::vector<uint8_t>> &buffers) {
    size_t total = 0;
    for (const auto &b : buffers) {
        total += b.size();
    }
    std::vector<uint8_t> result;
    result.reserve(total);
    for (const auto &b : buffers) {
        result.insert(result.end(), b.begin(), b.end());
    }
    return result;
}

std::string getExePath() {
    char result[PATH_MAX];
    ssize_t count = readlink("/proc/self/exe", result, PATH_MAX);
    return std::string(result, (count > 0) ? count : 0);
}

std::string getAppDir() {
    std::string path = getExePath();
    size_t pos = path.find_last_of("/");
    std::string dir = (pos != std::string::npos) ? path.substr(0, pos) : "";
    pos = dir.find_last_of("/");
    std::string parentDir = (pos != std::string::npos) ? dir.substr(0, pos) : dir;

    std::error_code ec;

    // 1. Portable: dir/app (e.g. tarball extracted with app folder next to executable)
    std::string portableAppDir = dir + "/app";
    if (std::filesystem::exists(portableAppDir, ec)) {
        return portableAppDir;
    }

    // 2. Portable: dir/share/fullstacked/app
    std::string portableShareAppDir = dir + "/share/fullstacked/app";
    if (std::filesystem::exists(portableShareAppDir, ec)) {
        return portableShareAppDir;
    }

    // 3. FHS standard (e.g. /usr/bin/fullstacked -> /usr/share/fullstacked/app, or bin/fullstacked -> share/fullstacked/app)
    std::string appDir = parentDir + "/share/fullstacked/app";
    if (std::filesystem::exists(appDir, ec)) {
        return appDir;
    }

    // 4. Check development path fallbacks
    std::string devPath = dir + "/../../../../app/out";
    if (std::filesystem::exists(devPath, ec)) {
        return std::filesystem::canonical(devPath, ec).string();
    }

    std::string devPath2 = dir + "/../../app/out";
    if (std::filesystem::exists(devPath2, ec)) {
        return std::filesystem::canonical(devPath2, ec).string();
    }

    return appDir;
}

void replaceAll(std::string &str, const std::string &from, const std::string &to) {
    if (from.empty()) return;
    size_t start_pos = 0;
    while ((start_pos = str.find(from, start_pos)) != std::string::npos) {
        str.replace(start_pos, from.length(), to);
        start_pos += to.length();
    }
}

void registerDesktopApp() {
    const char *homeEnv = getenv("HOME");
    if (!homeEnv) return;
    std::string home = homeEnv;

    std::string localIconsDir = home + "/.local/share/icons";
    std::error_code ec;
    std::filesystem::create_directories(localIconsDir, ec);

    std::string appDir = getAppDir();
    std::string iconFound = "";
    if (std::filesystem::exists(appDir, ec)) {
        for (const auto &entry : std::filesystem::directory_iterator(appDir, ec)) {
            if (entry.path().filename().string().find("app-icon") != std::string::npos && entry.path().extension() == ".png") {
                iconFound = entry.path().string();
                break;
            }
        }
    }
    if (iconFound.empty() && std::filesystem::exists(appDir + "/assets/icon.png", ec)) {
        iconFound = appDir + "/assets/icon.png";
    }
    if (!iconFound.empty()) {
        std::filesystem::copy_file(
            iconFound, localIconsDir + "/fullstacked.png",
            std::filesystem::copy_options::overwrite_existing, ec);
    }

    std::string localAppsDir = home + "/.local/share/applications";
    std::filesystem::create_directories(localAppsDir, ec);

    std::ofstream localAppFile(localAppsDir + "/fullstacked.desktop");
    if (localAppFile.is_open()) {
        std::string contents = "[Desktop Entry]\n"
                               "Name=FullStacked\n"
                               "Exec=" +
                               getExePath() +
                               " %u\n"
                               "Terminal=false\n"
                               "Type=Application\n"
                               "MimeType=x-scheme-handler/fullstacked;\n"
                               "Icon=fullstacked\n"
                               "Categories=Development;Utility;\n";
        localAppFile << contents;
        localAppFile.close();

        replaceAll(localAppsDir, "\\", "\\\\");
        replaceAll(localAppsDir, "'", "\\'");

        std::string command = "update-desktop-database '" + localAppsDir + "' 2>/dev/null";
        system(command.c_str());
    }
}

std::string gen_random(const int len) {
    static const char alphanum[] = "abcdefghijklmnopqrstuvwxyz";
    std::string tmp_s;
    tmp_s.reserve(len);
    for (int i = 0; i < len; ++i) {
        tmp_s += alphanum[rand() % (sizeof(alphanum) - 1)];
    }
    return tmp_s;
}