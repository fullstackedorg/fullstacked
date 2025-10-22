#include "./instance.h"
#include "../bin/linux.h"
#include "./app.h"
#include "./base64.h"
#include "./utils.h"
#include <iostream>

std::string notFound = "Not Found";

#ifdef GTK
std::string platform = "linux-gtk";
#else
std::string platform = "linux-qt";
#endif

Response Instance::onRequest(std::string url_str) {
    URL url(url_str);
    std::cout << "PATH: " << url.path << std::endl;

    std::vector<unsigned char> responseData = std::vector<unsigned char>(
        (unsigned char *)notFound.data(),
        (unsigned char *)notFound.data() + notFound.size());
    std::string responseType = "text/plain";

    if (url.path == "/platform") {
        responseData = std::vector<unsigned char>(
            (unsigned char *)platform.data(),
            (unsigned char *)platform.data() + platform.size());
    } else {
        char *payloadHeader = new char[2];
        payloadHeader[0] = 1; // Static File Serving
        payloadHeader[1] = 2; // STRING

        char *pathnameData = url.path.empty() ? new char[0] : url.path.data();
        int pathnameSize = url.path.size();

        char *pathnameSizeBuffer = new char[4];
        numberToCharPtr(pathnameSize, pathnameSizeBuffer);

        char *payloadBody = new char[4 + pathnameSize];
        int payloadBodySize = combineBuffers(
            pathnameSizeBuffer, 4, pathnameData, pathnameSize, payloadBody);

        char *payload = new char[2 + payloadBodySize];
        int payloadSize = combineBuffers(payloadHeader, 2, payloadBody,
                                         payloadBodySize, payload);

        auto argsData = callLib(payload, payloadSize);
        std::vector<DataValue> values = deserializeArgs(argsData);

        responseType = values.at(0).str;
        responseData = values.at(1).buffer;

        delete[] payloadHeader;
        if (url.path.empty()) {
            delete[] pathnameData;
        }
        delete[] pathnameSizeBuffer;
        delete[] payloadBody;
        delete[] payload;
    }

    Response response;
    response.data = responseData;
    response.type = responseType;

    return response;
}

std::string Instance::onBridge(std::string payload) {
    if (isEditor && !App::instance->deeplink.empty()) {
        std::cout << App::instance->deeplink << std::endl;
        std::string launchURL("fullstacked://" + App::instance->deeplink);
        onMessage(std::string("deeplink").data(), launchURL.data());
        App::instance->deeplink = "";
    }

    std::string b64 = base64_decode(payload);

    char *reqId = new char[4];
    memcpy(reqId, b64.data(), 4);

    auto libResponse = callLib((char *)(b64.data() + 4), b64.size() - 4);

    char *responseWithId = new char[libResponse.size() + 4];
    int responseWithIdSize =
        combineBuffers(reqId, 4, (char *)libResponse.data(), libResponse.size(),
                       responseWithId);

    return base64_encode(std::string(responseWithId, responseWithIdSize));
}

Instance::Instance(std::string pId, bool pIsEditor) {
    id = pId;
    isEditor = pIsEditor;

    if (isEditor) {
        header = new char[5];
        char *isEditorHeader = new char[1];
        isEditorHeader[0] = 1;
        char *idSize = new char[4];
        numberToCharPtr(0, idSize);
        headerSize = combineBuffers(isEditorHeader, 1, idSize, 4, header);
        delete[] isEditorHeader;
        delete[] idSize;
    } else {
        char *isEditorHeader = new char[1];
        isEditorHeader[0] = 0;

        char *idStrData = id.data();
        int idStrLength = id.size();

        char *intermediateBuffer = new char[1 + 4];
        char *idSize = new char[4];
        numberToCharPtr(idStrLength, idSize);
        headerSize =
            combineBuffers(isEditorHeader, 1, idSize, 4, intermediateBuffer);
        header = new char[headerSize + idStrLength];
        headerSize = combineBuffers(intermediateBuffer, headerSize, idStrData,
                                    idStrLength, header);

        delete[] isEditorHeader;
        delete[] intermediateBuffer;
        delete[] idSize;
    }
}

int reqId = 0;

std::vector<unsigned char> Instance::callLib(char *data, int size) {
    char *tmpHeader = new char[headerSize];
    memcpy(tmpHeader, header, headerSize);

    char *payload = new char[headerSize + size];
    int payloadSize =
        combineBuffers(tmpHeader, headerSize, data, size, payload);

    int libResponseSize = call(reqId, payload, payloadSize);

    char *libResponse = new char[libResponseSize];
    getResponse(reqId, libResponse);
    reqId++;

    std::vector<unsigned char> response((unsigned char *)libResponse,
                                        (unsigned char *)libResponse +
                                            libResponseSize);

    delete[] tmpHeader;
    delete[] payload;
    delete[] libResponse;

    return response;
}

void Instance::onMessage(char *type, std::string message) {
    if (isEditor && std::string(type) == "open") {
        App::instance->open(std::string(message), false);
        return;
    } else if (std::string(type) == "title") {
        window->setTitle(std::string(message));
        return;
    }

    window->onMessage(type, message);
}
