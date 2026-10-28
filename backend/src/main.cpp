#include <httplib.h>
#include <nlohmann/json.hpp>
#include <atomic>
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
  std::string sim_url;
  for (int i = 1; i < argc; ++i) {
    const std::string arg = argv[i];
    if (arg == "--port" && i + 1 < argc) {
      try {
        std::string value = argv[++i]; size_t end = 0;
        port = std::stoi(value, &end);
        if (end != value.size()) return 2;
      } catch (...) { return 2; }
    } else if (arg == "--web-root" && i + 1 < argc) web_root = argv[++i];
      else if (arg == "--sim-url" && i + 1 < argc) sim_url = argv[++i];
    else { std::cerr << "Usage: primebot_backend [--port 8080] [--web-root frontend] [--sim-url http://127.0.0.1:8090]\n"; return 2; }
  }
  if (port < 1 || port > 65535) return 2;

  /* 不给 --sim-url 时保持纯 mock：/motion 与 /control 继续返回 422，现有测试不受影响。 */
  const bool sim_enabled = !sim_url.empty();
  std::string sim_host = "127.0.0.1";
  int sim_port = 8090;
  if (sim_enabled) {
    const std::string prefix = "http://";
    if (sim_url.rfind(prefix, 0) != 0) { std::cerr << "--sim-url 需形如 http://127.0.0.1:8090\n"; return 2; }
    const std::string rest = sim_url.substr(prefix.size());
    const auto colon = rest.rfind(':');
    if (colon == std::string::npos || colon == 0) { std::cerr << "--sim-url 缺少主机或端口\n"; return 2; }
    try {
      sim_host = rest.substr(0, colon);
      std::string port_text = rest.substr(colon + 1); size_t end = 0;
      sim_port = std::stoi(port_text, &end);
      if (end != port_text.size()) return 2;
    } catch (...) { std::cerr << "--sim-url 端口非法\n"; return 2; }
    if (sim_port < 1 || sim_port > 65535) { std::cerr << "--sim-url 端口越界\n"; return 2; }
  }
  httplib::Server server;
  /* 静态资源带 no-cache：浏览器每次拿 If-Modified-Since 回来问一次，文件没改走 304、
     改了就立刻生效。调页面时最容易被旧 CSS/JS 骗到，这条省掉反复强刷 */
  server.set_file_request_handler([](const httplib::Request&, httplib::Response& res) {
    res.set_header("Cache-Control", "no-cache");
  });
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
  bool sim_session = false;
  std::atomic<unsigned long long> sim_serial{0};

  /* 仿真桥是独立进程，这里只转发、不缓存、不重试：
     桥挂掉必须立刻体现为 502，不能让页面以为指令已经执行。 */
  auto sim_call = [&](const std::string& method, const std::string& path, const std::string& body,
                      int& status, std::string& out) {
    httplib::Client client(sim_host, sim_port);
    client.set_connection_timeout(0, 300000);
    client.set_read_timeout(2, 0);
    client.set_write_timeout(1, 0);
    if (method == "GET") {
      auto result = client.Get(path.c_str());
      if (!result) return false;
      status = result->status; out = result->body;
      return true;
    }
    auto result = client.Post(path.c_str(), body, "application/json");
    if (!result) return false;
    status = result->status; out = result->body;
    return true;
  };
  auto sim_error = [](const std::string& body, const std::string& fallback) {
    try { return json::parse(body).value("error", fallback); } catch (...) { return fallback; }
  };

  auto response = [](httplib::Response& res, int status, const std::string& request_id,
                     const json& data, const std::string& code = "", const std::string& message = "") {
    res.status = status;
    json error = code.empty() ? json(nullptr) : json{{"code", code}, {"message", message}};
    res.set_content(json{{"request_id", request_id}, {"data", data}, {"error", error}}.dump(), "application/json; charset=utf-8");
  };
  const std::unordered_map<std::string,int> actions{{"q1.wave",3004},{"q1.heart",3007},{"q1.cheer",3008}};
  /* 页面若从别的本地端口打开（静态服务器、预览器），接口就是跨源的。
     只对 localhost / 127.0.0.1 来源放行，别把本机控制口暴露给任意网页。 */
  auto is_local_origin = [](const std::string& origin) {
    if(origin.rfind("http://",0)!=0) return false;
    std::string host=origin.substr(7);
    const auto colon=host.find(':');
    if(colon!=std::string::npos) host=host.substr(0,colon);
    return host=="localhost" || host=="127.0.0.1" || host=="[::1]";
  };
  auto allow_origin = [&](const httplib::Request& req, httplib::Response& res) {
    const auto origin=req.get_header_value("Origin");
    if(is_local_origin(origin)) {
      res.set_header("Access-Control-Allow-Origin",origin);
      res.set_header("Vary","Origin");
    }
  };
  auto handle = [&](const httplib::Request& req, httplib::Response& res) {
    allow_origin(req, res);
    /* 状态与画面是高频只读转发，刻意放在全局锁外：
       否则仿真一卡，一帧请求就能把整个页面拖住。 */
    if (sim_enabled && req.method == "GET" &&
        (req.path == "/api/v1/sim/state" || req.path == "/api/v1/sim/joints" ||
         req.path == "/api/v1/sim/frame")) {
      const auto rid = "req-" + std::to_string(sim_serial.fetch_add(1) + 1);
      const std::string target = req.path == "/api/v1/sim/joints" ? "/joints"
                               : req.path == "/api/v1/sim/frame" ? "/frame" : "/state";
      std::string out; int status = 0;
      if (!sim_call("GET", target, "", status, out)) {
        response(res, 502, rid, nullptr, "SIM_UNAVAILABLE", "仿真桥未响应，请确认 mujoco_bridge.py 已启动");
      } else if (status != 200) {
        response(res, 502, rid, nullptr, "SIM_ERROR", sim_error(out, "仿真桥返回异常"));
      } else if (target == "/frame") {
        res.status = 200;
        res.set_content(out, "image/jpeg");
        res.set_header("Cache-Control", "no-store");
      } else {
        try { response(res, 200, rid, json::parse(out)); }
        catch (...) { response(res, 502, rid, nullptr, "SIM_ERROR", "仿真桥返回了非法 JSON"); }
      }
      return;
    }
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
    /* executed=true 只用于仿真：桥真的改了 qpos。mock 分支保持原文案，
       现有测试断言 state=simulated / robot_executed=false 不受影响。 */
    auto operation = [&](const std::string& kind, const json& parameters,
                         const std::string& mode = "mock", bool executed = false) {
      auto id="op-"+std::to_string(serial);
      const std::string state = executed ? "applied" : "simulated";
      json op{{"operation_id",id},{"kind",kind},{"state",state},{"mode",mode},{"parameters",parameters},{"robot_executed",executed}};
      if(operations.size()>=1000) operations.clear();
      operations[id]=op;
      logs.push_back(json{{"id",serial},{"operation_id",id},{"kind",kind},{"mode",mode},{"state",state}});
      if(logs.size()>1000) logs.pop_front();
      response(res,200,request_id,op);
    };
    const auto& path=req.path;
    try {
      if(req.method=="GET" && path=="/api/v1/health")
        response(res,200,request_id,{{"service","primebot_backend"},{"version","0.1.0"},{"mode",sim_enabled?"sim":"mock"},{"ros2_implemented",false},{"sim_enabled",sim_enabled}});
      else if(req.method=="GET" && path=="/api/v1/robots") {
        json list=json::array({{{"robot_id","q1-mock"},{"name","Q1 模拟设备"},{"mode","mock"}}});
        if(sim_enabled) list.push_back({{"robot_id","q1-sim"},{"name","Q1 仿真设备 · MuJoCo"},{"mode","sim"}});
        response(res,200,request_id,list);
      } else if(req.method=="POST" && path=="/api/v1/connections") {
        const auto mode=input.value("mode",std::string());
        const auto robot=input.value("robot_id",std::string());
        if(mode=="sim") {
          std::string out; int status=0;
          if(!sim_enabled) fail(422,"SIM_NOT_CONFIGURED","未启用仿真：启动后端时加 --sim-url");
          else if(robot!="q1-sim") fail(404,"ROBOT_NOT_FOUND","仿真设备档案固定为 q1-sim");
          else if(!sim_call("GET","/health","",status,out)) fail(502,"SIM_UNAVAILABLE","仿真桥未响应，请先启动 mujoco_bridge.py");
          else { connected=true; sim_session=true; operation("connect",input,"sim",true); }
        } else if(mode!="mock") fail(422,"ROS2_NOT_IMPLEMENTED","当前版本仅模拟与仿真模式，不会连接真机");
        else if(robot!="q1-mock") fail(404,"ROBOT_NOT_FOUND","未知设备档案");
        else { connected=true; sim_session=false; operation("connect",input); }
      } else if(req.method=="DELETE" && path=="/api/v1/connection") {
        connected=false; sim_session=false;
        if(sim_enabled) { std::string out; int status=0; sim_call("POST","/cmd/stop","{}",status,out); }
        operation("disconnect",json::object());
      } else if(req.method=="GET" && path=="/api/v1/connection")
        response(res,200,request_id,{{"state",connected?"ready":"disconnected"},{"mode",sim_session?"sim":"mock"},{"robot_executed",sim_session}});
      else if(req.method=="GET" && path=="/api/v1/status") {
        json battery=connected?json{{"percent",56},{"source",sim_session?"sim":"mock"},{"stale",false}}:json(nullptr);
        response(res,200,request_id,{{"connection_state",connected?"ready":"disconnected"},{"mode",sim_session?"sim":"mock"},{"battery",battery},{"signal_rssi_dbm",nullptr},{"motion_available",sim_session},{"control_session",sim_session?"exclusive":"none"}});
      } else if(req.method=="GET" && path=="/api/v1/capabilities") {
        json list=json::array();
        for(const auto& [id,n]:actions) list.push_back({{"id",id},{"sdk_constant",n},{"category","action"},{"mode",sim_session?"sim":"mock"},{"verified_on_robot",false},{"enabled",connected}});
        response(res,200,request_id,{{"actions",list},{"emotions",json::array()},{"motion",sim_session},{"camera",sim_session},{"chat",false},{"gestures",sim_session?json::array({"wave","heart","cheer"}):json::array()}});
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
      } else if(sim_enabled && req.method=="POST" &&
                (path=="/api/v1/motion/base" || path=="/api/v1/motion/stop" ||
                 path=="/api/v1/control/joints" || path=="/api/v1/control/gesture" ||
                 path=="/api/v1/sim/reset" || path=="/api/v1/sim/mode" ||
                 path=="/api/v1/sim/preset" || path=="/api/v1/sim/gait" ||
                 path=="/api/v1/sim/camera" || path=="/api/v1/sim/speed")) {
        if(!connected) fail(503,"ROBOT_NOT_READY","请先建立仿真连接");
        else {
          const auto clampv=[](double v){ return v<-0.5?-0.5:(v>0.5?0.5:v); };
          const auto clampw=[](double v){ return v<-1.0?-1.0:(v>1.0?1.0:v); };
          json forward_body=input;
          std::string target, bad;
          if(path=="/api/v1/motion/base") {
            if((input.contains("vx")&&!input["vx"].is_number())||(input.contains("vy")&&!input["vy"].is_number())||(input.contains("wz")&&!input["wz"].is_number()))
              bad="vx、vy、wz 需为数值";
            else {
              // 底盘线速度 0.5 m/s、角速度 1.0 rad/s 封顶：网页就算传更大值也进不去
              forward_body={{"vx",clampv(input.value("vx",0.0))},{"vy",clampv(input.value("vy",0.0))},{"wz",clampw(input.value("wz",0.0))}};
              target="/cmd/base";
            }
          } else if(path=="/api/v1/motion/stop") target="/cmd/stop";
          else if(path=="/api/v1/control/joints") {
            if(!input.contains("joints")||!input["joints"].is_object()||input["joints"].empty()) bad="joints 需为非空对象";
            else { forward_body={{"pose",input["joints"]},{"duration_ms",input.value("duration_ms",300)}}; target="/cmd/pose"; }
          } else if(path=="/api/v1/control/gesture") {
            if(!input.contains("name")||!input["name"].is_string()) bad="需提供手势名 wave/heart/cheer/wave_both/dance/stretch";
            else { forward_body={{"name",input["name"]},{"speed",input.value("speed",2.5)}}; target="/cmd/gesture"; }
          } else if(path=="/api/v1/sim/mode") {
            const auto mode=input.value("mode",std::string());
            if(mode=="kinematic"||mode=="dynamic") { forward_body={{"mode",mode}}; target="/cmd/mode"; }
            else bad="mode 只能是 kinematic 或 dynamic";
          } else if(path=="/api/v1/sim/preset") {
            const auto name=input.value("name",std::string());
            if(name.empty()) bad="需提供姿态名，如 stand/tpose/squat/hands_up/reach";
            else { forward_body={{"name",name}}; target="/cmd/preset"; }
          } else if(path=="/api/v1/sim/gait") {
            // 空名与 off/stop 都表示停止步态
            forward_body={{"name",input.value("name",std::string("off"))}};
            target="/cmd/gait";
          } else if(path=="/api/v1/sim/camera") {
            json cam=json::object();
            for(const char* key : {"azimuth","elevation","distance"}) {
              if(!input.contains(key)) continue;
              if(!input[key].is_number()) { bad="camera 参数需为数值"; break; }
              cam[key]=input[key];
            }
            if(bad.empty() && input.contains("reset") && input["reset"].is_boolean()) cam["reset"]=input["reset"];
            if(bad.empty()) { forward_body=cam; target="/cmd/camera"; }
          } else if(path=="/api/v1/sim/speed") {
            if(!input.contains("speed")||!input["speed"].is_number()) bad="speed 需为数值";
            else { forward_body={{"speed",input["speed"]}}; target="/cmd/speed"; }
          } else target="/cmd/reset";

          if(!bad.empty()) fail(400,"INVALID_PARAMETERS",bad);
          else {
            std::string out; int status=0;
            if(!sim_call("POST",target,forward_body.dump(),status,out)) fail(502,"SIM_UNAVAILABLE","仿真桥未响应，请确认仿真进程仍在运行");
            else if(status!=200) fail(422,"SIM_REJECTED",sim_error(out,"仿真桥拒绝了该指令"));
            else operation(path.substr(8),forward_body,"sim",true);
          }
        }
      } else if(!sim_enabled && path.rfind("/api/v1/sim",0)==0)
        fail(422,"SIM_NOT_CONFIGURED","未启用仿真：启动后端时加 --sim-url");
      else if(path.rfind("/api/v1/motion",0)==0 || path.rfind("/api/v1/control",0)==0 || path.rfind("/api/v1/cameras",0)==0 || path.rfind("/api/v1/chat",0)==0 || path=="/api/v1/emotions")
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
  server.Options(R"(/api/v1/.*)", [&](const httplib::Request& req, httplib::Response& res) {
    allow_origin(req, res);
    res.set_header("Access-Control-Allow-Methods","GET, POST, PUT, DELETE, OPTIONS");
    res.set_header("Access-Control-Allow-Headers","Content-Type, Idempotency-Key");
    res.set_header("Access-Control-Max-Age","600");
    res.status = 204;
  });
  server.Get(R"(/api/v1/.*)",handle);
  server.Post(R"(/api/v1/.*)",handle);
  server.Put(R"(/api/v1/.*)",handle);
  server.Delete(R"(/api/v1/.*)",handle);
  if (sim_enabled) std::cout << "SIM MODE: http://127.0.0.1:" << port << " -> mujoco bridge " << sim_host << ":" << sim_port << std::endl;
  else std::cout << "MOCK ONLY: http://127.0.0.1:" << port << " (no robot connection)" << std::endl;
  return server.listen("127.0.0.1",port)?0:1;
}
