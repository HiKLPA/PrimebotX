#include "primebotx/web_system.h"

#include <sodium.h>
#include <sqlite3.h>

#include <algorithm>
#include <atomic>
#include <chrono>
#include <filesystem>
#include <mutex>
#include <nlohmann/json.hpp>
#include <regex>
#include <stdexcept>
#include <unordered_map>
using J = nlohmann::json;
namespace primebotx {
namespace {
long long now() {
  return std::chrono::duration_cast<std::chrono::seconds>(
             std::chrono::system_clock::now().time_since_epoch())
      .count();
}
std::string random_token() {
  unsigned char b[32];
  randombytes_buf(b, sizeof b);
  char h[65];
  sodium_bin2hex(h, sizeof h, b, sizeof b);
  return h;
}
std::string digest(const std::string& s) {
  unsigned char b[crypto_hash_sha256_BYTES];
  crypto_hash_sha256(b, reinterpret_cast<const unsigned char*>(s.data()), s.size());
  char h[65];
  sodium_bin2hex(h, sizeof h, b, sizeof b);
  return h;
}
struct Query {
  sqlite3_stmt* s = nullptr;
  Query(sqlite3* db, const char* sql) {
    if (sqlite3_prepare_v2(db, sql, -1, &s, nullptr) != SQLITE_OK)
      throw std::runtime_error("database prepare failed");
  }
  ~Query() { sqlite3_finalize(s); }
  void bind(int n, const std::string& x) {
    if (sqlite3_bind_text(s, n, x.c_str(), static_cast<int>(x.size()), SQLITE_TRANSIENT) !=
        SQLITE_OK)
      throw std::runtime_error("database bind failed");
  }
  void bind(int n, long long x) {
    if (sqlite3_bind_int64(s, n, x) != SQLITE_OK) throw std::runtime_error("database bind failed");
  }
  bool row() {
    int rc = sqlite3_step(s);
    if (rc == SQLITE_ROW) return true;
    if (rc != SQLITE_DONE) throw std::runtime_error("database operation failed");
    return false;
  }
  std::string text(int i) {
    auto v = sqlite3_column_text(s, i);
    return v ? reinterpret_cast<const char*>(v) : "";
  }
  long long num(int i) { return sqlite3_column_int64(s, i); }
};
const J catalog = J::array(
    {{{"id", "idle"}, {"label", "待机"}, {"clip", "idle"}, {"loop", true}},
     {{"id", "standby"}, {"label", "准备姿势"}, {"clip", "standby"}, {"loop", false}},
     {{"id", "raise_hand"}, {"label", "举手"}, {"clip", "raisehand"}, {"loop", false}},
     {{"id", "raise_hand_hold"},
      {"label", "举手呼吸"},
      {"clip", "raisehand_breath"},
      {"loop", true}},
     {{"id", "leg"}, {"label", "腿部动作一"}, {"clip", "leg"}, {"loop", false}},
     {{"id", "leg02"}, {"label", "腿部动作二"}, {"clip", "leg02"}, {"loop", false}},
     {{"id", "leg_breath"}, {"label", "腿部呼吸"}, {"clip", "leg_breath"}, {"loop", true}}});
}  // namespace
struct WebSystem::Impl {
  sqlite3* db = nullptr;
  std::mutex mutex;
  std::atomic<unsigned long long> serial{0};
  struct Bucket {
    long long start = 0;
    int count = 0;
  };
  std::unordered_map<std::string, Bucket> limits;
  std::string dummy_hash;
  explicit Impl(const std::string& path) {
    if (sodium_init() < 0) throw std::runtime_error("libsodium initialization failed");
    char h[crypto_pwhash_STRBYTES];
    if (crypto_pwhash_str_alg(h, "dummy-password", 14, crypto_pwhash_OPSLIMIT_INTERACTIVE,
                              crypto_pwhash_MEMLIMIT_INTERACTIVE,
                              crypto_pwhash_ALG_ARGON2ID13) != 0)
      throw std::runtime_error("password hashing unavailable");
    dummy_hash = h;
    const auto parent = std::filesystem::path(path).parent_path();
    if (!parent.empty()) std::filesystem::create_directories(parent);
    if (sqlite3_open_v2(path.c_str(), &db,
                        SQLITE_OPEN_READWRITE | SQLITE_OPEN_CREATE | SQLITE_OPEN_FULLMUTEX,
                        nullptr) != SQLITE_OK)
      throw std::runtime_error("cannot open database");
    sqlite3_busy_timeout(db, 5000);
    const char* sql =
        "PRAGMA foreign_keys=ON; PRAGMA journal_mode=WAL; CREATE TABLE IF NOT EXISTS users(id "
        "INTEGER PRIMARY KEY,username TEXT UNIQUE NOT NULL,display_name TEXT NOT "
        "NULL,password_hash TEXT NOT NULL,created_at INTEGER NOT NULL); CREATE TABLE IF NOT EXISTS "
        "sessions(token_hash TEXT PRIMARY KEY,user_id INTEGER NOT NULL REFERENCES "
        "users(id),created_at INTEGER NOT NULL,expires_at INTEGER NOT NULL); CREATE TABLE IF NOT "
        "EXISTS browser_sessions(id TEXT PRIMARY KEY,token_hash TEXT NOT NULL REFERENCES "
        "sessions(token_hash) ON DELETE CASCADE,created_at INTEGER NOT NULL,state TEXT NOT NULL); "
        "CREATE TABLE IF NOT EXISTS user_state(user_id INTEGER PRIMARY KEY REFERENCES "
        "users(id) ON DELETE CASCADE,state_json TEXT NOT NULL,updated_at INTEGER NOT NULL);";
    if (sqlite3_exec(db, sql, nullptr, nullptr, nullptr) != SQLITE_OK)
      throw std::runtime_error("database schema failed");
    if (path != ":memory:") {
      std::error_code ec;
      std::filesystem::permissions(
          path, std::filesystem::perms::owner_read | std::filesystem::perms::owner_write,
          std::filesystem::perm_options::replace, ec);
    }
  }
  ~Impl() {
    if (db) sqlite3_close(db);
  }
  bool throttle(const std::string& key, int max) {
    auto t = now();
    for (auto i = limits.begin(); i != limits.end();)
      if (t - i->second.start >= 60)
        i = limits.erase(i);
      else
        ++i;
    if (limits.size() > 10000) return true;
    auto& b = limits[key];
    if (t - b.start >= 60) b = {t, 0};
    return ++b.count > max;
  }
  void reply(httplib::Response& res, int status, const J& data, const std::string& code = "",
             const std::string& message = "") {
    res.status = status;
    res.set_header("Cache-Control", "no-store");
    res.set_content(
        J{{"request_id", "web-" + std::to_string(++serial)},
          {"data", data},
          {"error", code.empty() ? J(nullptr) : J{{"code", code}, {"message", message}}}}
            .dump(),
        "application/json; charset=utf-8");
  }
  bool handle(const httplib::Request& req, httplib::Response& res) {
    const auto& p = req.path;
    if (p == "/api/v1/health" || p == "/api/v1/ai/config") return false;
    auto fail = [&](int status, const std::string& code, const std::string& message) {
      reply(res, status, nullptr, code, message);
    };
    try {
      J input = J::object();
      if (!req.body.empty()) {
        input = J::parse(req.body);
        if (!input.is_object()) throw std::invalid_argument("JSON object required");
      }
      const bool signup = p == "/api/v1/auth/register", login = p == "/api/v1/auth/login";
      if ((signup || login) && req.method == "POST") {
        auto username = input.at("username").get<std::string>();
        auto password = input.at("password").get<std::string>();
        std::transform(username.begin(), username.end(), username.begin(),
                       [](unsigned char c) { return c >= 'A' && c <= 'Z' ? c + 32 : c; });
        if (!std::regex_match(username, std::regex("[a-z0-9_]{3,24}")) || password.size() < 8 ||
            password.size() > 16 ||
            std::any_of(password.begin(), password.end(),
                        [](unsigned char c) { return c < 32 || c > 126; })) {
          fail(400, "INVALID_PARAMETERS",
               "用户名需3至24位字母数字下划线；密码需8至16位可见ASCII字符");
          return true;
        }
        std::string name = input.value("display_name", username);
        size_t count = 0;
        for (unsigned char c : name)
          if ((c & 0xc0) != 0x80) ++count;
        if (signup &&
            (count == 0 || count > 32 ||
             std::all_of(name.begin(), name.end(), [](unsigned char c) { return c <= 32; }))) {
          fail(400, "INVALID_PARAMETERS", "昵称需1至32字符且非空白");
          return true;
        }
        {
          std::lock_guard<std::mutex> lock(mutex);
          if (throttle("ip:" + req.remote_addr, 40) ||
              throttle((signup ? "register:" : "login:") + username, 10)) {
            res.set_header("Retry-After", "60");
            fail(429, "RATE_LIMITED", "请求过于频繁，请稍后重试");
            return true;
          }
        }
        if (signup) {
          char hash[crypto_pwhash_STRBYTES];
          if (crypto_pwhash_str_alg(
                  hash, password.data(), password.size(), crypto_pwhash_OPSLIMIT_INTERACTIVE,
                  crypto_pwhash_MEMLIMIT_INTERACTIVE, crypto_pwhash_ALG_ARGON2ID13) != 0)
            throw std::runtime_error("password hash failed");
          sodium_memzero(password.data(), password.size());
          std::lock_guard<std::mutex> lock(mutex);
          Query exists(db, "SELECT id FROM users WHERE username=?");
          exists.bind(1, username);
          if (exists.row()) {
            fail(409, "USERNAME_EXISTS", "用户名已注册");
            return true;
          }
          Query q(
              db,
              "INSERT INTO users(username,display_name,password_hash,created_at) VALUES(?,?,?,?)");
          q.bind(1, username);
          q.bind(2, name);
          q.bind(3, std::string(hash));
          q.bind(4, now());
          q.row();
          reply(res, 201,
                {{"user",
                  {{"id", sqlite3_last_insert_rowid(db)},
                   {"username", username},
                   {"display_name", name}}}});
          return true;
        }
        std::string hash = dummy_hash;
        long long uid = 0;
        {
          std::lock_guard<std::mutex> lock(mutex);
          Query q(db, "SELECT id,display_name,password_hash FROM users WHERE username=?");
          q.bind(1, username);
          if (q.row()) {
            uid = q.num(0);
            name = q.text(1);
            hash = q.text(2);
          }
        }
        const bool valid =
            crypto_pwhash_str_verify(hash.c_str(), password.data(), password.size()) == 0;
        sodium_memzero(password.data(), password.size());
        if (!valid || !uid) {
          fail(401, "INVALID_CREDENTIALS", "用户名或密码错误");
          return true;
        }
        auto token = random_token();
        std::lock_guard<std::mutex> lock(mutex);
        Query clean(db, "DELETE FROM sessions WHERE expires_at<=?");
        clean.bind(1, now());
        clean.row();
        Query q(db, "INSERT INTO sessions VALUES(?,?,?,?)");
        q.bind(1, digest(token));
        q.bind(2, uid);
        q.bind(3, now());
        q.bind(4, now() + 28800);
        q.row();
        reply(res, 200,
              {{"access_token", token},
               {"token_type", "Bearer"},
               {"expires_in", 28800},
               {"user", {{"id", uid}, {"username", username}, {"display_name", name}}}});
        return true;
      }
      const auto auth = req.get_header_value("Authorization");
      std::string token = auth.rfind("Bearer ", 0) == 0 ? auth.substr(7) : "";
      if (!std::regex_match(token, std::regex("[a-f0-9]{64}"))) {
        fail(401, "UNAUTHORIZED", "请先登录");
        return true;
      }
      const auto token_hash = digest(token);
      std::lock_guard<std::mutex> lock(mutex);
      Query user(db,
                 "SELECT u.id,u.username,u.display_name FROM sessions s JOIN users u ON "
                 "u.id=s.user_id WHERE s.token_hash=? AND s.expires_at>?");
      user.bind(1, token_hash);
      user.bind(2, now());
      if (!user.row()) {
        fail(401, "UNAUTHORIZED", "登录已失效，请重新登录");
        return true;
      }
      // Release the database lock before the potentially slow AI proxy request.
      if ((p == "/api/v1/chat" || p == "/api/v1/ai/speech" || p == "/api/v1/ai/models") &&
          req.method == "POST")
        return false;
      J info = {{"id", user.num(0)}, {"username", user.text(1)}, {"display_name", user.text(2)}};
      if (p == "/api/v1/auth/me" && req.method == "GET") {
        reply(res, 200, {{"user", info}});
        return true;
      }
      if (p == "/api/v1/auth/state" && req.method == "GET") {
        Query q(db, "SELECT state_json,updated_at FROM user_state WHERE user_id=?");
        q.bind(1, user.num(0));
        if (!q.row()) {
          reply(res, 200, {{"state", nullptr}, {"updated_at", nullptr}});
          return true;
        }
        reply(res, 200, {{"state", J::parse(q.text(0))}, {"updated_at", q.num(1)}});
        return true;
      }
      if (p == "/api/v1/auth/state" && req.method == "PUT") {
        if (!input.contains("state") || !input["state"].is_object()) {
          fail(400, "INVALID_STATE", "用户状态必须是JSON对象");
          return true;
        }
        const auto packed = input["state"].dump();
        if (packed.size() > 256 * 1024) {
          fail(413, "STATE_TOO_LARGE", "用户状态不能超过256KB");
          return true;
        }
        const auto updated = now();
        Query q(db,
                "INSERT INTO user_state(user_id,state_json,updated_at) VALUES(?,?,?) ON "
                "CONFLICT(user_id) DO UPDATE SET state_json=excluded.state_json,"
                "updated_at=excluded.updated_at");
        q.bind(1, user.num(0));
        q.bind(2, packed);
        q.bind(3, updated);
        q.row();
        reply(res, 200, {{"saved", true}, {"updated_at", updated}});
        return true;
      }
      if (p == "/api/v1/auth/logout" && req.method == "POST") {
        Query q(db, "DELETE FROM sessions WHERE token_hash=?");
        q.bind(1, token_hash);
        q.row();
        reply(res, 200, {{"logged_out", true}});
        return true;
      }
      if (p == "/api/v1/browser/actions" && req.method == "GET") {
        reply(res, 200, {{"items", catalog}, {"execution_mode", "browser_animation"}});
        return true;
      }
      if (p == "/api/v1/browser/sessions" && req.method == "POST") {
        Query count(db, "SELECT COUNT(*) FROM browser_sessions WHERE token_hash=?");
        count.bind(1, token_hash);
        count.row();
        if (count.num(0) >= 20) {
          fail(429, "PAGE_LIMIT", "当前登录最多打开20个独立体验页面");
          return true;
        }
        auto id = random_token();
        J state = {{"action_id", "idle"}, {"revision", 0}};
        Query q(db, "INSERT INTO browser_sessions VALUES(?,?,?,?)");
        q.bind(1, id);
        q.bind(2, token_hash);
        q.bind(3, now());
        q.bind(4, state.dump());
        q.row();
        reply(res, 201, {{"session_id", id}, {"state", state}});
        return true;
      }
      const std::string prefix = "/api/v1/browser/sessions/";
      if (p.rfind(prefix, 0) == 0) {
        auto tail = p.substr(prefix.size());
        auto slash = tail.find('/');
        auto id = tail.substr(0, slash);
        auto operation = slash == std::string::npos ? "" : tail.substr(slash);
        Query q(db, "SELECT state FROM browser_sessions WHERE id=? AND token_hash=?");
        q.bind(1, id);
        q.bind(2, token_hash);
        if (!q.row()) {
          fail(404, "SESSION_NOT_FOUND", "页面会话不存在或不属于当前登录");
          return true;
        }
        J state = J::parse(q.text(0));
        if (operation.empty() && req.method == "GET") {
          reply(res, 200, {{"session_id", id}, {"state", state}});
          return true;
        }
        if (operation.empty() && req.method == "DELETE") {
          Query del(db, "DELETE FROM browser_sessions WHERE id=? AND token_hash=?");
          del.bind(1, id);
          del.bind(2, token_hash);
          del.row();
          reply(res, 200, {{"deleted", true}});
          return true;
        }
        if (operation == "/actions" && req.method == "POST") {
          auto action = input.at("action_id").get<std::string>();
          auto it = std::find_if(catalog.begin(), catalog.end(),
                                 [&](const J& x) { return x["id"] == action; });
          if (it == catalog.end()) {
            fail(422, "UNKNOWN_ACTION", "动作不在浏览器动作库中");
            return true;
          }
          state = {{"action_id", action}, {"revision", state.value("revision", 0) + 1}};
          Query update(db, "UPDATE browser_sessions SET state=? WHERE id=? AND token_hash=?");
          update.bind(1, state.dump());
          update.bind(2, id);
          update.bind(3, token_hash);
          update.row();
          reply(res, 200,
                {{"session_id", id},
                 {"state", state},
                 {"playback", *it},
                 {"execution_mode", "browser_animation"},
                 {"status", "authorized"},
                 {"robot_executed", false}});
          return true;
        }
        fail(404, "NOT_FOUND", "接口不存在");
        return true;
      }
      fail(404, "NOT_FOUND", "接口不存在");
      return true;
    } catch (const J::exception&) {
      fail(400, "INVALID_PARAMETERS", "请求字段或JSON格式不合法");
      return true;
    } catch (const std::invalid_argument&) {
      fail(400, "INVALID_PARAMETERS", "请求体必须为JSON对象");
      return true;
    } catch (const std::exception&) {
      fail(500, "INTERNAL_ERROR", "服务处理失败");
      return true;
    }
  }
};
WebSystem::WebSystem(const std::string& path) : impl_(new Impl(path)) {}
WebSystem::~WebSystem() = default;
bool WebSystem::handle(const httplib::Request& req, httplib::Response& res) {
  return impl_->handle(req, res);
}
}  // namespace primebotx
