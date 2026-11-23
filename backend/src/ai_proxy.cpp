#include "primebotx/ai_proxy.h"

#include <httplib.h>

#include <stdexcept>

namespace primebotx {

AiProxy::AiProxy(const std::string& url) {
  constexpr const char* prefix = "http://";
  if (url.rfind(prefix, 0) != 0) {
    throw std::invalid_argument("--ai-url 需形如 http://127.0.0.1:8091");
  }
  const std::string rest = url.substr(7);
  const auto colon = rest.rfind(':');
  if (colon == std::string::npos || colon == 0 || colon + 1 >= rest.size()) {
    throw std::invalid_argument("--ai-url 缺少主机或端口");
  }
  host_ = rest.substr(0, colon);
  if (host_ != "127.0.0.1" && host_ != "localhost") {
    throw std::invalid_argument("--ai-url 只允许本机 127.0.0.1 或 localhost");
  }
  try {
    size_t end = 0;
    port_ = std::stoi(rest.substr(colon + 1), &end);
    if (end != rest.size() - colon - 1 || port_ < 1 || port_ > 65535) {
      throw std::invalid_argument("invalid port");
    }
  } catch (...) {
    throw std::invalid_argument("--ai-url 端口非法");
  }
}

AiResponse AiProxy::chat(const std::string& body, const std::string& idempotency_key) const {
  return request("POST", "/chat", body, {{"Idempotency-Key", idempotency_key}});
}

AiResponse AiProxy::get_config() const {
  return request("GET", "/config", "");
}

AiResponse AiProxy::configure(const std::string& body) const {
  return request("POST", "/config", body);
}

AiResponse AiProxy::list_models(const std::string& body) const {
  return request("POST", "/models", body);
}

AiResponse AiProxy::speech(const std::string& body) const {
  return request("POST", "/speech", body);
}

AiResponse AiProxy::request(const std::string& method, const std::string& path,
                            const std::string& body,
                            const httplib::Headers& headers) const {
  httplib::Client client(host_, port_);
  client.set_connection_timeout(0, 500000);
  client.set_read_timeout(35, 0);
  client.set_write_timeout(2, 0);
  auto result = method == "GET"
      ? client.Get(path.c_str(), headers)
      : client.Post(path.c_str(), headers, body, "application/json");
  if (!result) return {};
  return {true, result->status, result->body};
}

}  // namespace primebotx
