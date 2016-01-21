var myController = RouteController.extend({
    onBeforeAction: function() {
        Session.set("hello", "world");
    }
});

Router.route("/home", function(){
		Session.set("hello", "world");
});

Router.route("/upload", function(){
		var fs = Npm.require("fs");
}, {
	where: "server"
});