document.title=gs("View Image");var data=null;
function onLoad(a){if(a)if(a=getBG(),a.g_img_data)data=a.g_img_data,a.g_img_data=null,document.getElementById("imgviewer").src=data;else{if(a.g_audio_data){var b=document.createElement("audio");b.setAttribute("controls","controls");b.setAttribute("autobuffer","autobuffer");b.setAttribute("autoplay","autoplay");var c=document.createElement("source");c.setAttribute("src",a.g_audio_data);b.appendChild(c);document.body.appendChild(b);document.getElementById("imgviewer").style.display="none"}}else get_data("img",
function(){onLoad(!0)})}document.addEventListener("DOMContentLoaded",function(){window.addEventListener("load",function(){onLoad()})});