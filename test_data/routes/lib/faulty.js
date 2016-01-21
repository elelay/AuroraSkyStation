var myController = RouteController.extend({
    onBeforeAction: function() {
		var fs = Npm.require("fs");
    }
});

Router.route("/home", function(){
		var fs = Npm.require("fs");
});

Router.route("/upload", function(){
		Session.set("hello", "world");
}, {
	where: "server"
});