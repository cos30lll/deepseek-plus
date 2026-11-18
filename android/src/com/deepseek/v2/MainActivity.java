package com.deepseek.v2;

import android.app.*;
import android.content.*;
import android.content.pm.PackageManager;
import android.graphics.Color;
import android.net.Uri;
import android.os.*;
import android.security.keystore.*;
import android.util.Base64;
import android.view.*;
import android.webkit.*;
import android.widget.Toast;
import org.json.*;
import javax.crypto.*;
import javax.crypto.spec.GCMParameterSpec;
import javax.crypto.SecretKey;
import java.io.*;
import java.net.*;
import java.security.KeyStore;
import java.util.*;
import java.util.concurrent.*;
import java.util.concurrent.atomic.AtomicBoolean;

/** Offline, first-party-only WebView host. No external page receives the JavaScript bridge. */
public final class MainActivity extends Activity {
    static final String HOST="appassets.androidplatform.net", HOME="https://"+HOST+"/assets/index.html", ALIAS="source_chat_aes_v1";
    WebView web; volatile boolean destroyed; final Handler main=new Handler(Looper.getMainLooper());
    final ExecutorService workers=Executors.newFixedThreadPool(4);
    final ConcurrentHashMap<String,Job> jobs=new ConcurrentHashMap<>();
    ValueCallback<Uri[]> filePicker; PermissionRequest microphone; byte[] exportBytes;
    static final class Job { final AtomicBoolean stopped=new AtomicBoolean(); volatile HttpURLConnection connection; }
    @Override public void onCreate(Bundle state) {
        super.onCreate(state);
        getWindow().setStatusBarColor(Color.rgb(245,246,248));getWindow().setNavigationBarColor(Color.rgb(245,246,248));
        getWindow().getDecorView().setSystemUiVisibility(View.SYSTEM_UI_FLAG_LIGHT_STATUS_BAR|View.SYSTEM_UI_FLAG_LIGHT_NAVIGATION_BAR);
        getWindow().setSoftInputMode(WindowManager.LayoutParams.SOFT_INPUT_ADJUST_RESIZE);
        web=new WebView(this);setContentView(web);
        WebSettings settings=web.getSettings();settings.setJavaScriptEnabled(true);settings.setDomStorageEnabled(true);
        settings.setAllowFileAccess(false);settings.setAllowContentAccess(true);settings.setJavaScriptCanOpenWindowsAutomatically(false);
        settings.setMixedContentMode(WebSettings.MIXED_CONTENT_NEVER_ALLOW);settings.setMediaPlaybackRequiresUserGesture(true);
        settings.setSupportMultipleWindows(false);WebView.setWebContentsDebuggingEnabled(false);
        web.setBackgroundColor(Color.rgb(245,246,248));web.addJavascriptInterface(new Bridge(),"NativeApi");
        android.webkit.CookieManager.getInstance().setAcceptThirdPartyCookies(web,false);
        web.setWebViewClient(new WebViewClient(){
            @Override public WebResourceResponse shouldInterceptRequest(WebView view,WebResourceRequest request){
                Uri uri=request.getUrl();
                if(!"https".equals(uri.getScheme())||!HOST.equals(uri.getHost())||!"GET".equals(request.getMethod()))return denied();
                String path=uri.getPath();
                if(path==null||!path.startsWith("/assets/")||path.contains("..")||path.indexOf('\\')>=0)return denied();
                try {
                    String name=path.substring(8);InputStream input=getAssets().open("www/"+name);
                    Map<String,String> headers=new HashMap<>();headers.put("Cache-Control","no-cache");headers.put("X-Content-Type-Options","nosniff");
                    headers.put("Content-Security-Policy","default-src 'self'; script-src 'self' 'wasm-unsafe-eval'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob: https:; font-src 'self' data:; media-src 'self' blob: data:; connect-src 'self' https: http:; worker-src 'self'; frame-src 'none'; object-src 'none'; base-uri 'self'");
                    return new WebResourceResponse(mime(name),"UTF-8",200,"OK",headers,input);
                }catch(IOException e){return denied();}
            }
            @Override public boolean shouldOverrideUrlLoading(WebView view,WebResourceRequest request){
                Uri uri=request.getUrl();
                if(HOST.equals(uri.getHost())&&"https".equals(uri.getScheme())&&"/assets/index.html".equals(uri.getPath()))return false;
                if(request.isForMainFrame()&&("https".equals(uri.getScheme())||"http".equals(uri.getScheme()))){
                    try{startActivity(new Intent(Intent.ACTION_VIEW,uri).addCategory(Intent.CATEGORY_BROWSABLE));}catch(Exception ignored){}
                }
                return true;
            }
            @Override public void onReceivedSslError(WebView view,android.webkit.SslErrorHandler handler,android.net.http.SslError error){handler.cancel();}
        });
        web.setWebChromeClient(new WebChromeClient(){
            @Override public boolean onShowFileChooser(WebView view,ValueCallback<Uri[]> result,FileChooserParams params){
                if(filePicker!=null)filePicker.onReceiveValue(null);filePicker=result;
                try{Intent intent=new Intent(Intent.ACTION_OPEN_DOCUMENT).addCategory(Intent.CATEGORY_OPENABLE).setType("*/*");intent.putExtra(Intent.EXTRA_ALLOW_MULTIPLE,params.getMode()==FileChooserParams.MODE_OPEN_MULTIPLE);startActivityForResult(intent,10);}catch(Exception e){filePicker.onReceiveValue(null);filePicker=null;notifyUser("没有可用的文件选择器");}
                return true;
            }
            @Override public void onPermissionRequest(PermissionRequest request){
                main.post(()->{
                    if(!trusted()||!HOST.equals(request.getOrigin().getHost())||!Arrays.asList(request.getResources()).contains(PermissionRequest.RESOURCE_AUDIO_CAPTURE)){request.deny();return;}
                    if(checkSelfPermission("android.permission.RECORD_AUDIO")==PackageManager.PERMISSION_GRANTED){request.grant(new String[]{PermissionRequest.RESOURCE_AUDIO_CAPTURE});return;}
                    if(microphone!=null)microphone.deny();microphone=request;requestPermissions(new String[]{"android.permission.RECORD_AUDIO"},20);
                });
            }
            @Override public void onPermissionRequestCanceled(PermissionRequest request){main.post(()->{if(microphone==request)microphone=null;});}
        });
        web.loadUrl(HOME);
    }
    static String mime(String name){if(name.endsWith(".js"))return "application/javascript";if(name.endsWith(".css"))return "text/css";if(name.endsWith(".html"))return "text/html";if(name.endsWith(".json"))return "application/json";if(name.endsWith(".woff2"))return "font/woff2";if(name.endsWith(".woff"))return "font/woff";if(name.endsWith(".ttf"))return "font/ttf";if(name.endsWith(".svg"))return "image/svg+xml";return "application/octet-stream";}
    static WebResourceResponse denied(){return new WebResourceResponse("text/plain","UTF-8",403,"Forbidden",Collections.emptyMap(),new ByteArrayInputStream(new byte[0]));}
    boolean trusted(){return !destroyed; /* Main-frame navigation is restricted to bundled HOME before bridge injection. */}
    void notifyUser(String value){main.post(()->{if(!destroyed)Toast.makeText(this,value,Toast.LENGTH_LONG).show();});}
    void emit(String id,String kind,String value,boolean wait)throws InterruptedException{
        if(destroyed)return;CountDownLatch latch=new CountDownLatch(1);
        main.post(()->{if(destroyed){latch.countDown();return;}web.evaluateJavascript("window.__nativeResponse&&window.__nativeResponse("+JSONObject.quote(id)+","+JSONObject.quote(kind)+","+JSONObject.quote(value)+")",result->latch.countDown());});
        if(wait&&!latch.await(15,TimeUnit.SECONDS))throw new InterruptedException("网页未及时处理响应");
    }
    SecretKey key()throws Exception{KeyStore store=KeyStore.getInstance("AndroidKeyStore");store.load(null);if(!store.containsAlias(ALIAS)){KeyGenerator generator=KeyGenerator.getInstance("AES","AndroidKeyStore");generator.init(new KeyGenParameterSpec.Builder(ALIAS,KeyProperties.PURPOSE_ENCRYPT|KeyProperties.PURPOSE_DECRYPT).setBlockModes(KeyProperties.BLOCK_MODE_GCM).setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE).build());generator.generateKey();}return (SecretKey)store.getKey(ALIAS,null);}
    public final class Bridge {
        @JavascriptInterface public synchronized String getSecret(String name){
            if(!trusted()||name==null||!name.matches("profile:[a-zA-Z0-9_-]{1,100}"))return "";
            String raw=getSharedPreferences("vault",0).getString(name,"");if(raw.isEmpty())return "";
            try{String[] parts=raw.split(":",2);Cipher cipher=Cipher.getInstance("AES/GCM/NoPadding");cipher.init(Cipher.DECRYPT_MODE,key(),new GCMParameterSpec(128,Base64.decode(parts[0],Base64.NO_WRAP)));return new String(cipher.doFinal(Base64.decode(parts[1],Base64.NO_WRAP)),"UTF-8");}catch(Exception e){notifyUser("此服务商的 Key 读取失败，请重新填写");return "";}
        }
        @JavascriptInterface public synchronized boolean setSecret(String name,String value){
            if(!trusted()||name==null||!name.matches("profile:[a-zA-Z0-9_-]{1,100}")||value==null||value.length()>16384)return false;
            try{if(value.isEmpty())return getSharedPreferences("vault",0).edit().remove(name).commit();Cipher cipher=Cipher.getInstance("AES/GCM/NoPadding");cipher.init(Cipher.ENCRYPT_MODE,key());String raw=Base64.encodeToString(cipher.getIV(),Base64.NO_WRAP)+":"+Base64.encodeToString(cipher.doFinal(value.getBytes("UTF-8")),Base64.NO_WRAP);return getSharedPreferences("vault",0).edit().putString(name,raw).commit();}catch(Exception e){return false;}
        }
        @JavascriptInterface public void request(String id,String url,String method,String headers,String body){
            if(!trusted()||id==null||id.length()>100)return;
            Job job=new Job();
            if(jobs.size()>=6||jobs.putIfAbsent(id,job)!=null){try{emit(id,"error","同时请求过多，请稍后重试",false);}catch(Exception ignored){}return;}
            workers.execute(()->network(id,url,method,headers,body,job));
        }
        @JavascriptInterface public void openExternal(String address){
            if(!trusted()||address==null||address.length()>8192)return;
            try{
                URI uri=new URI(address);String scheme=uri.getScheme();
                if(!("https".equalsIgnoreCase(scheme)||"http".equalsIgnoreCase(scheme))||uri.getHost()==null||uri.getRawUserInfo()!=null)throw new IllegalArgumentException();
                main.post(()->{if(!trusted())return;try{startActivity(new Intent(Intent.ACTION_VIEW,Uri.parse(address)).addCategory(Intent.CATEGORY_BROWSABLE));}catch(Exception error){notifyUser("无法打开浏览器");}});
            }catch(Exception error){notifyUser("服务商地址无效");}
        }
        @JavascriptInterface public void cancel(String id){Job job=jobs.get(id);if(job!=null){job.stopped.set(true);HttpURLConnection connection=job.connection;if(connection!=null)new Thread(connection::disconnect,"api-cancel").start();}}
        @JavascriptInterface public void saveFile(String name,String encoded){
            if(!trusted()||encoded==null||encoded.length()>90*1024*1024)return;
            main.post(()->{if(exportBytes!=null){notifyUser("已有一个导出任务");return;}try{exportBytes=Base64.decode(encoded,Base64.NO_WRAP);Intent intent=new Intent(Intent.ACTION_CREATE_DOCUMENT).addCategory(Intent.CATEGORY_OPENABLE).setType(name!=null&&name.toLowerCase(Locale.ROOT).endsWith(".json")?"application/json":"application/zip").putExtra(Intent.EXTRA_TITLE,name.replaceAll("[\\\\/]","_"));startActivityForResult(intent,11);}catch(Exception e){exportBytes=null;notifyUser("导出失败");}});
        }
    }
    void network(String id,String rawUrl,String method,String rawHeaders,String encoded,Job job){
        HttpURLConnection connection=null;
        try {
            URL url=new URL(rawUrl);URI uri=url.toURI();
            if(!(url.getProtocol().equals("https")||url.getProtocol().equals("http"))||uri.getRawUserInfo()!=null||uri.getFragment()!=null||url.getHost().isEmpty())throw new IOException("无效的 API 地址");
            if(!Arrays.asList("GET","POST","DELETE").contains(method))throw new IOException("不支持的请求方法");
            if(job.stopped.get())return;
            connection=(HttpURLConnection)url.openConnection();job.connection=connection;
            connection.setInstanceFollowRedirects(false);connection.setConnectTimeout(20000);connection.setReadTimeout(180000);connection.setRequestMethod(method);
            JSONObject headers=new JSONObject(rawHeaders);Iterator<String> keys=headers.keys();
            while(keys.hasNext()){String name=keys.next(),value=headers.getString(name);if(name.matches("[a-zA-Z0-9-]+")&&!name.equalsIgnoreCase("Host")&&!name.equalsIgnoreCase("Content-Length")&&!value.contains("\n")&&!value.contains("\r"))connection.setRequestProperty(name,value);}
            connection.setRequestProperty("Accept-Encoding","identity");
            if(!encoded.isEmpty()){
                if(encoded.length()>56*1024*1024)throw new IOException("请求体过大");byte[] bytes=Base64.decode(encoded,Base64.NO_WRAP);connection.setDoOutput(true);connection.setFixedLengthStreamingMode(bytes.length);
                try(OutputStream output=connection.getOutputStream()){output.write(bytes);}
            }
            if(job.stopped.get())return;
            int code=connection.getResponseCode();if(code>=300&&code<400)throw new IOException("API 返回重定向，请直接填写最终地址；不会把 Key 转发到重定向站点");
            JSONObject resultHeaders=new JSONObject();for(Map.Entry<String,List<String>> entry:connection.getHeaderFields().entrySet())if(entry.getKey()!=null&&!entry.getValue().isEmpty())resultHeaders.put(entry.getKey(),String.join(", ",entry.getValue()));
            emit(id,"headers",new JSONObject().put("status",code).put("headers",resultHeaders).toString(),true);
            InputStream response=code>=400?connection.getErrorStream():connection.getInputStream();
            if(response!=null)try(InputStream input=response){byte[] bytes=new byte[8192];int length,total=0;while(!job.stopped.get()&&(length=input.read(bytes))!=-1){total+=length;if(total>64*1024*1024)throw new IOException("响应超过 64 MiB 上限");emit(id,"data",Base64.encodeToString(bytes,0,length,Base64.NO_WRAP),true);}}
            if(!job.stopped.get())emit(id,"end","",false);
        }catch(Exception error){if(!job.stopped.get()&&!destroyed)try{emit(id,"error",error instanceof java.net.SocketTimeoutException?"API 连接或响应超时":error instanceof javax.net.ssl.SSLException?"TLS 证书验证失败":error.getMessage()==null?"API 网络请求失败":error.getMessage(),false);}catch(Exception ignored){}
        }finally{jobs.remove(id);if(connection!=null)connection.disconnect();}
    }
    @Override public void onRequestPermissionsResult(int code,String[] permissions,int[] results){super.onRequestPermissionsResult(code,permissions,results);if(code==20&&microphone!=null){if(results.length>0&&results[0]==PackageManager.PERMISSION_GRANTED&&trusted())microphone.grant(new String[]{PermissionRequest.RESOURCE_AUDIO_CAPTURE});else microphone.deny();microphone=null;}}
    @Override protected void onActivityResult(int request,int result,Intent data){super.onActivityResult(request,result,data);
        if(request==10&&filePicker!=null){ValueCallback<Uri[]> callback=filePicker;filePicker=null;List<Uri> files=new ArrayList<>();if(result==RESULT_OK&&data!=null){ClipData clip=data.getClipData();if(clip!=null){for(int i=0;i<clip.getItemCount();i++)files.add(clip.getItemAt(i).getUri());}else if(data.getData()!=null)files.add(data.getData());}callback.onReceiveValue(files.isEmpty()?null:files.toArray(new Uri[0]));}
        if(request==11){byte[] bytes=exportBytes;exportBytes=null;if(bytes!=null&&result==RESULT_OK&&data!=null&&data.getData()!=null){Uri uri=data.getData();workers.execute(()->{try(OutputStream stream=getContentResolver().openOutputStream(uri)){if(stream==null)throw new IOException();stream.write(bytes);notifyUser("文件已保存");}catch(Exception e){notifyUser("文件保存失败");}});}}
    }
    @Override public void onBackPressed(){web.evaluateJavascript("window.__sourceBack?window.__sourceBack():false",result->{if("false".equals(result))moveTaskToBack(true);});}
    @Override protected void onDestroy(){destroyed=true;for(Job job:jobs.values()){job.stopped.set(true);if(job.connection!=null){HttpURLConnection c=job.connection;new Thread(c::disconnect,"api-close").start();}}jobs.clear();workers.shutdownNow();if(filePicker!=null)filePicker.onReceiveValue(null);if(microphone!=null)microphone.deny();if(web!=null){web.removeJavascriptInterface("NativeApi");web.stopLoading();web.destroy();}super.onDestroy();}
}
