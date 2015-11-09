Template.sayHello.helpers({
    hello: function() {
        return "hello " + Template.currentData();
    }
});