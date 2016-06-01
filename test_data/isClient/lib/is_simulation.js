if (this.isSimulation) {
    var x = Session.get("toto");
}

if (!this.isSimulation) {
    Meteor.publish("dummy");
}
