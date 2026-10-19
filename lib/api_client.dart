import 'dart:convert';
import 'package:http/http.dart' as http;
import 'package:shared_preferences/shared_preferences.dart';

class PhoneShopApi {
  PhoneShopApi({String? baseUrl}) : baseUrl = baseUrl ?? 'https://trend-wed-colin-openings.trycloudflare.com/api';

  final String baseUrl;
  String? _token;

  Future<void> loadToken() async {
    final prefs = await SharedPreferences.getInstance();
    _token = prefs.getString('phoneshop_token');
  }

  Future<void> clearToken() async {
    _token = null;
    final prefs = await SharedPreferences.getInstance();
    await prefs.remove('phoneshop_token');
  }

  Future<Map<String, dynamic>> health() async => _request('GET', '/health');

  Future<Map<String, dynamic>> login(String email, String password) async {
    final result = await _request('POST', '/auth/login', body: {
      'email': email,
      'password': password,
    });
    final token = result['token'];
    if (token is String) {
      _token = token;
      final prefs = await SharedPreferences.getInstance();
      await prefs.setString('phoneshop_token', token);
    }
    return result;
  }

  Future<Map<String, dynamic>> register({
    required String name,
    required String email,
    required String password,
  }) => _request('POST', '/auth/register', body: {
    'name': name,
    'email': email,
    'password': password,
  });

  Future<Map<String, dynamic>> _request(
    String method,
    String path, {
    Map<String, dynamic>? body,
  }) async {
    final headers = <String, String>{'Content-Type': 'application/json'};
    if (_token != null) headers['Authorization'] = 'Bearer $_token';
    final uri = Uri.parse('$baseUrl$path');
    final response = switch (method) {
      'GET' => await http.get(uri, headers: headers),
      'POST' => await http.post(uri, headers: headers, body: jsonEncode(body ?? {})),
      _ => throw UnsupportedError('HTTP method $method'),
    };
    final decoded = response.body.isEmpty ? <String, dynamic>{} : jsonDecode(response.body);
    if (response.statusCode < 200 || response.statusCode >= 300) {
      final message = decoded is Map ? decoded['message'] ?? decoded['error'] : 'Request failed';
      throw Exception(message);
    }
    return Map<String, dynamic>.from(decoded as Map);
  }
}

final phoneShopApi = PhoneShopApi();
