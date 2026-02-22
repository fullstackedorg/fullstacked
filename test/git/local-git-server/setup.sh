rm -rf /var/www/git
mkdir -p /var/www/git

mkrepo empty

mkrepo test
cd ~
git clone http://test:testing@0.0.0.0:80/test
cd test
echo "test file" > test.txt
git config --global user.email test@testing.com
git config --global user.name "test user"
git add .
git commit -m "test commit"
git push origin main