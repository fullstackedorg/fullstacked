#ifndef INSTANCE_H_
#define INSTANCE_H_

#include "./gui.h"

class Instance {
    private:
        bool isEditor;
        char *header;
        int headerSize;

    public:
        std::string id;
        Window *window;

        Instance(std::string pId, bool pIsEditor);

        std::vector<unsigned char> callLib(char *data, int size);

        Response onRequest(std::string path);

        std::string onBridge(std::string payload);

        void onMessage(char *type, std::string message);
};

#endif
