#include <httplib.h>
#include "primebotx/ai_proxy.h"
#include "primebotx/web_system.h"
#include <sodium.h>
#include <memory>
#include <nlohmann/json.hpp>
#include <atomic>
#include <cstdlib>
#include <fstream>
#include <iostream>
#include <mutex>
#include <string>
#include <stdexcept>
#include <unordered_set>
#include <vector>

using json = nlohmann::json;

bool load_assistant_capabilities(
    std::unordered_set<std::string>& motions,
    std::unordered_set<std::string>& poses,
    std::unordered_set<std::string>& views,
    std::unordered_set<std::string>& emotions,
    int& max_commands,
    int& max_motions) {
  motions.clear();
  poses.clear();
  views.clear();
  emotions.clear();
  std::vector<std::string> candidates;
  if (const char* configured = std::getenv("PRIMEBOTX_CAPABILITIES")) candidates.emplace_back(configured);
  candidates.insert(candidates.end(), {
    "assistant/capabilities.json",
    "../assistant/capabilities.json",
    "../../assistant/capabilities.json",
  });
  for (const auto& path : candidates) {
    std::ifstream input(path);
    if (!input) continue;
    try {
      json value;
      input >> value;
      const auto load_ids = [](const json& items, std::unordered_set<std::string>& target) {
        for (const auto& item : items) target.insert(item.at("id").get<std::string>());
      };
      load_ids(value.at("motions"), motions);
      load_ids(value.at("poses"), poses);
      load_ids(value.at("views"), views);
      load_ids(value.at("emotions"), emotions);
      max_commands = value.at("limits").at("max_commands").get<int>();
      max_motions = value.at("limits").at("max_motions").get<int>();
      if (motions.empty() || poses.empty() || views.empty() || emotions.empty() ||
          max_commands < 1 || max_motions < 1) {
        throw std::runtime_error("capability collections must not be empty");
      }
      return true;
    } catch (const std::exception& error) {
      std::cerr << "Invalid assistant capability manifest " << path << ": " << error.what() << "\n";
      return false;
    }
  }
  std::cerr << "assistant/capabilities.json not found\n";
  return false;
}

int main(int argc, char** argv) {
  int port = 8080;
  std::string db_path="data/primebotx.db";
  std::string web_root;
  std::string ai_url;
  for (int i = 1; i < argc; ++i) {
    const std::string arg = argv[i];
    if (arg == "--db-path" && i+1<argc) db_path=argv[++i];
    else if (arg == "--port" && i + 1 < argc) {
      try {
        std::string value = argv[++i]; size_t end = 0;
        port = std::stoi(value, &end);
        if (end != value.size()) return 2;
      } catch (...) { return 2; }
    } else if (arg == "--web-root" && i + 1 < argc) web_root = argv[++i];
    else if (arg == "--ai-url" && i + 1 < argc) ai_url = argv[++i];
    else { std::cerr << "Usage: primebotx_backend [--port 8080] [--web-root frontend] [--ai-url http://127.0.0.1:8091] [--db-path data/primebotx.db]\n"; return 2; }
  }
  if (port < 1 || port > 65535) return 2;

  std::unique_ptr<primebotx::WebSystem> web;
  try { web=std::make_unique<primebotx::WebSystem>(db_path); }
  catch(const std::exception& e) {
    std::cerr << e.what() << std::endl;
    return 2;
  }
  std::unique_ptr<primebotx::AiProxy> ai;
  if (!ai_url.empty()) {
    try { ai=std::make_unique<primebotx::AiProxy>(ai_url); }
    catch(const std::exception& e) { std::cerr << e.what() << std::endl; return 2; }
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
    server.Get("/", [&](const httplib::Request&, httplib::Response& res) {
      res.set_redirect("/ui/PrimebotX.html");
    });
  }
  std::mutex mutex;
  std::atomic<unsigned long long> ai_serial{0};

  auto response = [](httplib::Response& res, int status, const std::string& request_id,
                     const json& data, const std::string& code = "", const std::string& message = "") {
    res.status = status;
    json error = code.empty() ? json(nullptr) : json{{"code", code}, {"message", message}};
    res.set_content(json{{"request_id", request_id}, {"data", data}, {"error", error}}.dump(), "application/json; charset=utf-8");
  };
  std::unordered_set<std::string> ai_actions, ai_poses, ai_views, ai_emotions;
  int max_ai_commands = 0, max_ai_motions = 0;
  const auto reload_ai_capabilities = [&]() {
    return load_assistant_capabilities(
        ai_actions, ai_poses, ai_views, ai_emotions, max_ai_commands, max_ai_motions);
  };
  if (!reload_ai_capabilities()) {
    return 2;
  }
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
    if(web && web->handle(req,res)) return;
    if (req.method == "GET" && req.path == "/api/v1/health") {
      response(res, 200, "health", {{"service", "primebotx_backend"}, {"version", "0.1.0"}});
      return;
    }
    /* 模型配置只允许本机页面读取和修改。API Key 写进本机 AI 服务，
       不存进浏览器，也不通过 GET 返回给页面。 */
    if ((req.method == "GET" || req.method == "PUT") &&
        req.path == "/api/v1/ai/config") {
      const auto request_id = "req-ai-config-" + std::to_string(ai_serial.fetch_add(1) + 1);
      auto fail = [&](int status, const std::string& code, const std::string& message) {
        response(res, status, request_id, nullptr, code, message);
      };
      if (!ai) {
        fail(503, "AI_NOT_CONFIGURED", "本地 AI 服务尚未启动");
        return;
      }
      if (req.method == "PUT") {
        const auto peer = req.remote_addr;
        const bool local_peer = peer.empty() || peer == "127.0.0.1" ||
                                peer == "::1" || peer == "::ffff:127.0.0.1";
        if (!local_peer) {
          fail(403, "AI_CONFIG_LOCAL_ONLY", "模型配置只允许从本机修改");
          return;
        }
        if (req.body.empty() || req.body.size() > 8192) {
          fail(413, "BODY_TOO_LARGE", "配置请求需为1至8192字节");
          return;
        }
        try {
          const auto value = json::parse(req.body);
          if (!value.is_object()) throw std::runtime_error("object required");
        } catch (...) {
          fail(400, "INVALID_JSON", "配置请求必须为JSON对象");
          return;
        }
      }
      const auto upstream = req.method == "GET" ? ai->get_config() : ai->configure(req.body);
      if (!upstream.connected) {
        fail(502, "AI_UNAVAILABLE", "本地 AI 服务未响应");
        return;
      }
      if (upstream.status != 200) {
        try {
          const auto error = json::parse(upstream.body).at("error");
          fail(upstream.status, error.value("code", "AI_UPSTREAM_ERROR"),
               error.value("message", "模型配置失败"));
        } catch (...) {
          fail(502, "AI_UPSTREAM_ERROR", "模型配置服务返回异常");
        }
        return;
      }
      try {
        const auto data = json::parse(upstream.body);
        if (!data.is_object() || !data.contains("configured") ||
            !data["configured"].is_boolean() || !data.contains("model") ||
            !data["model"].is_string()) {
          throw std::runtime_error("invalid ai config response");
        }
        response(res, 200, request_id, data);
      } catch (...) {
        fail(502, "AI_INVALID_RESPONSE", "模型配置服务返回了非法响应");
      }
      return;
    }
    /* DeepSeek 可能等待数十秒，保持代理请求不占用账号数据库的业务锁。 */
    if (req.method == "POST" && req.path == "/api/v1/ai/models") {
      const auto request_id = "req-ai-models-" + std::to_string(ai_serial.fetch_add(1) + 1);
      auto fail = [&](int status, const std::string& code, const std::string& message) {
        response(res, status, request_id, nullptr, code, message);
      };
      if (!ai) {
        fail(503, "AI_NOT_CONFIGURED", "本地 AI 服务尚未启动");
        return;
      }
      if (req.body.empty() || req.body.size() > 8192) {
        fail(413, "BODY_TOO_LARGE", "模型列表请求需为 1 至 8192 字节");
        return;
      }
      try {
        if (!json::parse(req.body).is_object()) throw std::runtime_error("object required");
      } catch (...) {
        fail(400, "INVALID_JSON", "模型列表请求必须为 JSON 对象");
        return;
      }
      const auto upstream = ai->list_models(req.body);
      if (!upstream.connected) {
        fail(502, "AI_UNAVAILABLE", "本地 AI 服务未响应");
        return;
      }
      if (upstream.status != 200) {
        try {
          const auto error = json::parse(upstream.body).at("error");
          fail(upstream.status, error.value("code", "AI_UPSTREAM_ERROR"),
               error.value("message", "获取模型列表失败"));
        } catch (...) {
          fail(502, "AI_UPSTREAM_ERROR", "模型列表服务返回异常");
        }
        return;
      }
      try {
        const auto data = json::parse(upstream.body);
        if (!data.is_object() || !data.contains("models") || !data["models"].is_array()) {
          throw std::runtime_error("invalid model list");
        }
        for (const auto& item : data["models"]) {
          if (!item.is_string() || item.get<std::string>().empty()) {
            throw std::runtime_error("invalid model id");
          }
        }
        response(res, 200, request_id, data);
      } catch (...) {
        fail(502, "AI_INVALID_RESPONSE", "模型列表服务返回了非法响应");
      }
      return;
    }
    if (req.method == "POST" && req.path == "/api/v1/ai/speech") {
      const auto request_id = "req-ai-speech-" + std::to_string(ai_serial.fetch_add(1) + 1);
      auto fail = [&](int status, const std::string& code, const std::string& message) {
        response(res, status, request_id, nullptr, code, message);
      };
      if (!ai) {
        fail(503, "AI_NOT_CONFIGURED", "本地 AI 服务尚未启动");
        return;
      }
      if (req.body.empty() || req.body.size() > 8192) {
        fail(413, "BODY_TOO_LARGE", "语音请求需为 1 至 8192 字节");
        return;
      }
      try {
        const auto value = json::parse(req.body);
        if (!value.is_object() || !value.contains("text") || !value["text"].is_string() ||
            value["text"].get<std::string>().empty()) {
          throw std::runtime_error("invalid speech request");
        }
        if (value.contains("voice") && !value["voice"].is_string()) {
          throw std::runtime_error("invalid speech voice");
        }
      } catch (...) {
        fail(400, "INVALID_SPEECH_REQUEST", "语音请求格式不正确");
        return;
      }
      const auto upstream = ai->speech(req.body);
      if (!upstream.connected) {
        fail(502, "AI_UNAVAILABLE", "本地语音服务未响应");
        return;
      }
      if (upstream.status != 200) {
        int status = upstream.status;
        if (status != 400 && status != 413 && status != 502 && status != 503) status = 502;
        try {
          const auto error = json::parse(upstream.body).at("error");
          fail(status, error.value("code", "TTS_UPSTREAM_ERROR"),
               error.value("message", "自然语音服务暂时不可用"));
        } catch (...) {
          fail(502, "TTS_UPSTREAM_ERROR", "自然语音服务返回异常");
        }
        return;
      }
      res.status = 200;
      res.set_content(upstream.body, "audio/mpeg");
      res.set_header("Cache-Control", "no-store");
      return;
    }
    if (req.method == "POST" && req.path == "/api/v1/chat") {
      const auto request_id = "req-ai-" + std::to_string(ai_serial.fetch_add(1) + 1);
      auto fail = [&](int status, const std::string& code, const std::string& message) {
        response(res, status, request_id, nullptr, code, message);
      };
      if (!ai) {
        fail(503, "AI_NOT_CONFIGURED", "未配置 DeepSeek，请先设置 .env 并重新启动");
        return;
      }
      const auto key = req.get_header_value("Idempotency-Key");
      if (key.empty() || key.size() > 128) {
        fail(400, "INVALID_IDEMPOTENCY_KEY", "写操作需要1至128字节的 Idempotency-Key");
        return;
      }
      if (req.body.empty() || req.body.size() > 8192) {
        fail(413, "BODY_TOO_LARGE", "请求体需为1至8192字节");
        return;
      }
      json input;
      try { input = json::parse(req.body); }
      catch (...) { fail(400, "INVALID_JSON", "请求体必须为JSON对象"); return; }
      const auto text_length = [](const std::string& text) {
        size_t count = 0;
        for (unsigned char byte : text) if ((byte & 0xc0) != 0x80) ++count;
        return count;
      };
      if (!input.is_object() || !input.contains("message") || !input["message"].is_string()) {
        fail(400, "INVALID_CHAT_MESSAGE", "message 需为1至500个字符");
        return;
      }
      const auto message = input["message"].get<std::string>();
      const auto visible = message.find_first_not_of(" \t\r\n") != std::string::npos;
      if (!visible || text_length(message) > 500) {
        fail(400, "INVALID_CHAT_MESSAGE", "message 需为1至500个字符");
        return;
      }
      if (input.contains("history")) {
        if (!input["history"].is_array() || input["history"].size() > 10) {
          fail(400, "INVALID_CHAT_HISTORY", "history 最多包含10条消息");
          return;
        }
        for (const auto& item : input["history"]) {
          if (!item.is_object() || !item.contains("role") || !item["role"].is_string() ||
              !item.contains("content") || !item["content"].is_string()) {
            fail(400, "INVALID_CHAT_HISTORY", "history 中的消息格式不正确");
            return;
          }
          const auto role = item["role"].get<std::string>();
          const auto content = item["content"].get<std::string>();
          if ((role != "user" && role != "assistant") ||
              content.find_first_not_of(" \t\r\n") == std::string::npos ||
              text_length(content) > 500) {
            fail(400, "INVALID_CHAT_HISTORY", "history 只接受1至500字符的 user 和 assistant 文本");
            return;
          }
        }
      }
      // Namespace upstream idempotency keys by authenticated session.
      std::string upstream_key = key;
      if (web) {
        const auto identity = req.get_header_value("Authorization");
        unsigned char hash[crypto_hash_sha256_BYTES];
        crypto_hash_sha256(hash, reinterpret_cast<const unsigned char*>(identity.data()),
                           identity.size());
        char hex[crypto_hash_sha256_BYTES * 2 + 1];
        sodium_bin2hex(hex, sizeof hex, hash, sizeof hash);
        const auto scoped = std::string(hex) + ":" + key;
        crypto_hash_sha256(hash, reinterpret_cast<const unsigned char*>(scoped.data()),
                           scoped.size());
        sodium_bin2hex(hex, sizeof hex, hash, sizeof hash);
        upstream_key = hex;
      }
      const auto upstream = ai->chat(req.body, upstream_key);
      if (!upstream.connected) {
        fail(502, "AI_UNAVAILABLE", "本地 AI 服务未响应，请确认 deepseek_bridge.py 已启动");
        return;
      }
      if (upstream.status != 200) {
        int status = upstream.status;
        if (status != 400 && status != 409 && status != 429 && status != 502 && status != 503) status = 502;
        try {
          const auto error = json::parse(upstream.body).at("error");
          fail(status, error.value("code", "AI_UPSTREAM_ERROR"),
               error.value("message", "AI 服务返回异常"));
        } catch (...) {
          fail(502, "AI_UPSTREAM_ERROR", "AI 服务返回异常");
        }
        return;
      }
      try {
        std::lock_guard<std::mutex> capability_guard(mutex);
        if (!reload_ai_capabilities()) {
          throw std::runtime_error("capability manifest reload failed");
        }
        const auto data = json::parse(upstream.body);
        if (!data.is_object() || !data.contains("reply") || !data["reply"].is_string() ||
            !data.contains("action_id") ||
            !(data["action_id"].is_null() || data["action_id"].is_string()) ||
            !data.contains("model") || !data["model"].is_string()) {
          throw std::runtime_error("invalid ai response");
        }
        if (data["action_id"].is_string() &&
            ai_actions.find(data["action_id"].get<std::string>()) == ai_actions.end()) {
          throw std::runtime_error("unknown ai action");
        }
        if (data.contains("actions")) {
          if (!data["actions"].is_array() ||
              data["actions"].size() > static_cast<size_t>(max_ai_motions)) {
            throw std::runtime_error("invalid ai action sequence");
          }
          for (const auto& action : data["actions"]) {
            if (!action.is_string() || ai_actions.find(action.get<std::string>()) == ai_actions.end()) {
              throw std::runtime_error("unknown ai action");
            }
          }
        }
        if (data.contains("stop") && !data["stop"].is_boolean()) {
          throw std::runtime_error("invalid ai stop command");
        }
        if (data.contains("commands")) {
          if (!data["commands"].is_array() ||
              data["commands"].size() > static_cast<size_t>(max_ai_commands)) {
            throw std::runtime_error("invalid ai command sequence");
          }
          int motion_count = 0;
          for (const auto& command : data["commands"]) {
            if (!command.is_object() || !command.contains("type") || !command["type"].is_string()) {
              throw std::runtime_error("invalid ai command");
            }
            const auto type = command["type"].get<std::string>();
            if (type == "motion") {
              if (!command.contains("id") || !command["id"].is_string() ||
                  ai_actions.find(command["id"].get<std::string>()) == ai_actions.end()) {
                throw std::runtime_error("unknown ai motion");
              }
              ++motion_count;
            } else if (type == "pose") {
              if (!command.contains("id") || !command["id"].is_string() ||
                  ai_poses.find(command["id"].get<std::string>()) == ai_poses.end()) {
                throw std::runtime_error("unknown ai pose");
              }
            } else if (type == "view") {
              if (!command.contains("preset") || !command["preset"].is_string() ||
                  ai_views.find(command["preset"].get<std::string>()) == ai_views.end()) {
                throw std::runtime_error("unknown ai view");
              }
            } else if (type == "emotion") {
              if (!command.contains("id") || !command["id"].is_string() ||
                  ai_emotions.find(command["id"].get<std::string>()) == ai_emotions.end()) {
                throw std::runtime_error("unknown ai emotion");
              }
            } else if (type != "reset_pose" && type != "reset_view") {
              throw std::runtime_error("unknown ai command type");
            }
          }
          if (motion_count > max_ai_motions ||
              (data.value("stop", false) && !data["commands"].empty())) {
            throw std::runtime_error("invalid ai command count");
          }
        }
        response(res, 200, request_id, data);
      } catch (...) {
        fail(502, "AI_INVALID_RESPONSE", "AI 服务返回了非法响应");
      }
      return;
    }
    response(res, 404, "not-found", nullptr, "NOT_FOUND", "接口不存在");
  };
  server.set_payload_max_length(8192);
  server.Options(R"(/api/v1/.*)", [&](const httplib::Request& req, httplib::Response& res) {
    allow_origin(req, res);
    res.set_header("Access-Control-Allow-Methods","GET, POST, PUT, DELETE, OPTIONS");
    res.set_header("Access-Control-Allow-Headers","Content-Type, Idempotency-Key, Authorization");
    res.set_header("Access-Control-Max-Age","600");
    res.status = 204;
  });
  server.Get(R"(/api/v1/.*)",handle);
  server.Post(R"(/api/v1/.*)",handle);
  server.Put(R"(/api/v1/.*)",handle);
  server.Delete(R"(/api/v1/.*)",handle);
  std::cout << "PrimebotX backend: http://127.0.0.1:" << port << std::endl;
  return server.listen("127.0.0.1",port)?0:1;
}
