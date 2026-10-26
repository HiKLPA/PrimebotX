#include <httplib.h>
#include <nlohmann/json.hpp>
#include <chrono>
#include <deque>
#include <iostream>
#include <mutex>
#include <regex>
#include <string>
#include <stdexcept>
#include <unordered_map>

using json = nlohmann::json;
using Clock = std::chrono::steady_clock;

// Deliberately mock-only: no ROS, sockets to Q1, or motor commands are issued.
int main(int argc, char** argv) {
  int port = 8080;
  std::string web_root;
  for (int i = 1; i < argc; ++i) {
    const std::string arg = argv[i];
    if (arg == "--port" && i + 1 < argc) {
      try {
        std::string value = argv[++i]; size_t end = 0;
        port = std::stoi(value, &end);
        if (end != value.size()) return 2;
      } catch (...) { return 2; }
    } else if (arg == "--web-root" && i + 1 < argc) web_root = argv[++i];
    else { std::cerr << "Usage: primebot_backend [--port 8080] [--web-root frontend]\n"; return 2; }
  }
  if (port < 1 || port > 65535) return 2;
  httplib::Server server;
  if (!web_root.empty()) {
    if (!server.set_mount_point("/ui", web_root)) {
      std::cerr << "Invalid frontend directory\n"; return 2;
    }
    server.Get("/", [](const httplib::Request&, httplib::Response& res) {
      res.set_redirect("/ui/PrrimebotX.html");
    });
  }
  std::mutex mutex;
  bool connected = false, muted = false;
  int volume = 50;
  unsigned long long serial = 0;
  std::deque<json> logs;
  std::unordered_map<std::string, json> operations;
  struct Cached { std::string fingerprint; int status; std::string body; Clock::time_point at; };
  std::unordered_map<std::string, Cached> cache;

  auto response = [](httplib::Response& res, int status, const std::string& request_id,
                     const json& data, const std::string& code = "", const std::string& message = "") {
    res.status = status;
    json error = code.empty() ? json(nullptr) : json{{"code", code}, {"message", message}};
    res.set_content(json{{"request_id", request_id}, {"data", data}, {"error", error}}.dump(), "application/json; charset=utf-8");
  };
  const std::unordered_map<std::string,int> actions{{"q1.wave",3004},{"q1.heart",3007},{"q1.cheer",3008}};
  auto handle = [&](const httplib::Request& req, httplib::Response& res) {
    std::lock_guard<std::mutex> guard(mutex);
    const auto request_id = "req-" + std::to_string(++serial);
    auto fail = [&](int status, const std::string& code, const std::string& msg) { response(res,status,request_id,nullptr,code,msg); };
    bool write = req.method != "GET";
    const auto key = req.get_header_value("Idempotency-Key");
    const auto fingerprint = req.method + " " + req.path + "\n" + req.body;
    const auto now = Clock::now();
    for (auto it=cache.begin(); it!=cache.end();) {
      if (now-it->second.at > std::chrono::minutes(10)) it=cache.erase(it); else ++it;
    }
    if (write) {
      if (key.empty() || key.size()>128) { fail(400,"INVALID_IDEMPOTENCY_KEY","写操作需要1至128字节的 Idempotency-Key"); return; }
      auto it=cache.find(key);
      if(it!=cache.end()) {
        if(it->second.fingerprint!=fingerprint) fail(409,"IDEMPOTENCY_CONFLICT","相同请求键不能提交不同内容");
        else { res.status=it->second.status; res.set_content(it->second.body,"application/json; charset=utf-8"); }
        return;
      }
      if(cache.size()>=10000) { fail(503,"REQUEST_CACHE_FULL","去重窗口已满，请稍后提交"); return; }
    }
    json input = json::object();
    if (req.body.size() > 8192) { fail(413,"BODY_TOO_LARGE","请求体超过8192字节"); return; }
    if (!req.body.empty()) {
      try { input=json::parse(req.body); if(!input.is_object()) throw std::runtime_error("object required"); }
      catch(...) { fail(400,"INVALID_JSON","请求体必须为JSON对象"); return; }
    }
    auto operation = [&](const std::string& kind, const json& parameters) {
      auto id="op-"+std::to_string(serial);
      json op{{"operation_id",id},{"kind",kind},{"state","simulated"},{"mode","mock"},{"parameters",parameters},{"robot_executed",false}};
      if(operations.size()>=1000) operations.clear();
      operations[id]=op;
      logs.push_back(json{{"id",serial},{"operation_id",id},{"kind",kind},{"mode","mock"},{"state","simulated"}});
      if(logs.size()>1000) logs.pop_front();
      response(res,200,request_id,op);
    };
    const auto& path=req.path;
    try {
      if(req.method=="GET" && path=="/api/v1/health")
        response(res,200,request_id,{{"service","primebot_backend"},{"version","0.1.0"},{"mode","mock"},{"ros2_implemented",false}});
      else if(req.method=="GET" && path=="/api/v1/robots")
        response(res,200,request_id,json::array({{{"robot_id","q1-mock"},{"name","Q1 模拟设备"},{"mode","mock"}}}));
      else if(req.method=="POST" && path=="/api/v1/connections") {
        if(input.value("mode",std::string())!="mock") fail(422,"ROS2_NOT_IMPLEMENTED","当前版本仅模拟模式，不会连接真机");
        else if(input.value("robot_id",std::string())!="q1-mock") fail(404,"ROBOT_NOT_FOUND","未知设备档案");
        else { connected=true; operation("connect",input); }
      } else if(req.method=="DELETE" && path=="/api/v1/connection") {
        connected=false; operation("disconnect",json::object());
      } else if(req.method=="GET" && path=="/api/v1/connection")
        response(res,200,request_id,{{"state",connected?"ready":"disconnected"},{"mode","mock"},{"robot_executed",false}});
      else if(req.method=="GET" && path=="/api/v1/status") {
        json battery=connected?json{{"percent",56},{"source","mock"},{"stale",false}}:json(nullptr);
        response(res,200,request_id,{{"connection_state",connected?"ready":"disconnected"},{"mode","mock"},{"battery",battery},{"signal_rssi_dbm",nullptr},{"motion_available",false}});
      } else if(req.method=="GET" && path=="/api/v1/capabilities") {
        json list=json::array();
        for(const auto& [id,n]:actions) list.push_back({{"id",id},{"sdk_constant",n},{"category","action"},{"mode","mock"},{"verified_on_robot",false},{"enabled",connected}});
        response(res,200,request_id,{{"actions",list},{"emotions",json::array()},{"motion",false},{"camera",false},{"chat",false}});
      } else if(req.method=="GET" && path=="/api/v1/logs") {
        unsigned long long after=0;
        if(req.has_param("after_id")) {
          const auto s=req.get_param_value("after_id");
          if(!std::regex_match(s,std::regex("[0-9]{1,18}"))) { fail(400,"INVALID_CURSOR","after_id须为非负整数"); return; }
          after=std::stoull(s);
        }
        int limit=100;
        if(req.has_param("limit")) {
          const auto s=req.get_param_value("limit");
          if(!std::regex_match(s,std::regex("[0-9]{1,3}"))) { fail(400,"INVALID_LIMIT","limit须为1至200"); return; }
          limit=std::stoi(s);
        }
        if(limit<1 || limit>200) { fail(400,"INVALID_LIMIT","limit须为1至200"); return; }
        json out=json::array(); auto next=after;
        for(const auto& log:logs) if(log["id"].get<unsigned long long>()>after && out.size()<static_cast<size_t>(limit)) {out.push_back(log);next=log["id"].get<unsigned long long>();}
        response(res,200,request_id,{{"items",out},{"next_after_id",next},{"truncated",!logs.empty() && after>0 && after<logs.front()["id"].get<unsigned long long>()}});
      } else if(req.method=="GET" && path.rfind("/api/v1/operations/",0)==0) {
        auto it=operations.find(path.substr(19));
        if(it==operations.end()) fail(404,"OPERATION_NOT_FOUND","操作不存在或已淘汰");
        else response(res,200,request_id,it->second);
      } else if(path.rfind("/api/v1/motion",0)==0 || path.rfind("/api/v1/control",0)==0 || path.rfind("/api/v1/cameras",0)==0 || path.rfind("/api/v1/chat",0)==0 || path=="/api/v1/emotions")
        fail(422,"NOT_IMPLEMENTED","此能力尚未实现，不会向机器人下发指令");
      else if((path=="/api/v1/tts" && req.method=="POST") || (path=="/api/v1/actions" && req.method=="POST") || (path=="/api/v1/audio" && (req.method=="GET" || req.method=="PUT"))) {
        if(!connected) fail(503,"ROBOT_NOT_READY","请先建立模拟连接");
        else if(path=="/api/v1/tts") {
          auto text=input.at("text").get<std::string>();
          size_t count=0; bool visible=false;
          for(unsigned char c:text) {if((c&0xc0)!=0x80) ++count; if(c>32) visible=true;}
          if(!visible || count>300) fail(400,"INVALID_TEXT","文本需为1至300字符且非空白");
          else { bool interrupt=input.value("interrupt",false); operation("tts",{{"text",text},{"interrupt",interrupt}}); }
        } else if(path=="/api/v1/actions") {
          auto id=input.at("action_id").get<std::string>();
          if(!actions.count(id)) fail(422,"UNKNOWN_ACTION","动作不在白名单中");
          else operation("action",{{"action_id",id},{"sdk_constant",actions.at(id)}});
        } else if(req.method=="GET") response(res,200,request_id,{{"volume",volume},{"muted",muted},{"mode","mock"}});
        else {
          int new_volume=volume; bool new_muted=muted;
          if(!input.contains("volume") && !input.contains("muted")) { fail(400,"INVALID_AUDIO","至少提供volume或muted"); return; }
          if(input.contains("volume")) {
            if(!input["volume"].is_number_integer()) {fail(400,"INVALID_VOLUME","音量须为0至100整数");return;}
            auto number=input["volume"].get<long long>();
            if(number<0 || number>100) {fail(400,"INVALID_VOLUME","音量须为0至100整数");return;}
            new_volume=static_cast<int>(number);
          }
          if(input.contains("muted")) new_muted=input["muted"].get<bool>();
          volume=new_volume; muted=new_muted; operation("audio",{{"volume",volume},{"muted",muted}});
        }
      } else fail(404,"NOT_FOUND","接口不存在");
    } catch(const json::exception&) { fail(400,"INVALID_PARAMETERS","参数缺失或类型不正确"); }
      catch(const std::exception&) { fail(500,"INTERNAL_ERROR","后端处理异常"); }
    if(write) cache.emplace(key,Cached{fingerprint,res.status,res.body,now});
  };
  server.set_payload_max_length(8192);
  server.Get(R"(/api/v1/.*)",handle);
  server.Post(R"(/api/v1/.*)",handle);
  server.Put(R"(/api/v1/.*)",handle);
  server.Delete(R"(/api/v1/.*)",handle);
  std::cout << "MOCK ONLY: http://127.0.0.1:" << port << " (no robot connection)" << std::endl;
  return server.listen("127.0.0.1",port)?0:1;
}
