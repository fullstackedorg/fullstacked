import SwiftUI

class Instance {
    static var callId = 0
    
    public let isEditor: Bool
    public let id: String
    private var header: Data
    
    
    init (projectId: String, isEditor: Bool = false) {
        self.isEditor = isEditor
        self.id = projectId
        
        self.header = Data()
        if(isEditor) {
            self.header.append(Data([1])) // isEditor
            self.header.append(0.toBytes()) // no project id
        } else {
            self.header.append(Data([0]))
            let projectIdData = self.id.data(using: .utf8)!
            self.header.append(projectIdData.count.toBytes())
            self.header.append(projectIdData)
        }
    }
    
    func callLib(payload: Data) -> Data {
        var data = Data()
        data.append(self.header)
        data.append(payload)
        
        let id = Int32(Instance.callId);
        let size = call(id, data.ptr(), Int32(data.count))
        
        let responsePtr = UnsafeMutableRawPointer.allocate(byteCount: Int(size), alignment: 1)
        
        getResponse(id, responsePtr)
        
        let response = Data(bytes: responsePtr, count: Int(size))
        responsePtr.deallocate()
        
        Instance.callId += 1;
        
        return response
    }
}
