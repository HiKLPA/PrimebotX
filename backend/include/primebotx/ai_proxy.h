#pragma once

#include <httplib.h>

#include <string>

namespace primebotx {

struct AiResponse {
  bool connected = false;
  int status = 0;
  std::string body;
};

class AiProxy {
 public:
  explicit AiProxy(const std::string& url);
  AiResponse chat(const std::string& body, const std::string& idempotency_key) const;
  AiResponse get_config() const;
  AiResponse configure(const std::string& body) const;
  AiResponse list_models(const std::string& body) const;
  AiResponse speech(const std::string& body) const;

 private:
  AiResponse request(const std::string& method, const std::string& path,
                     const std::string& body,
                     const httplib::Headers& headers = {}) const;
  std::string host_;
  int port_ = 0;
};

}  // namespace primebotx
