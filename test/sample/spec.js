(function($) {
    describe("sample > ", function() {
        beforeEach(function(done) {
            var promise = $.get('/test/sample/skeleton.html');
            promise.success(function(res) {

                $('body').append(res);

                done();
            });
        });

        afterEach(function() {
            $('body').html('');
        });

        it("샘플 테스트 코드", function() {
            expect(true).toBeTruthy();
        });
    });
})(jQuery);
