Here are this week's orders as CSV:

```csv
order_id,customer,amount
1001,Acme,120.50
1002,Globex,80.00
1003,Acme,45.25
1004,Initech,300.00
1005,Globex,19.99
1006,Acme,10.00
1007,Umbrella,75.00
1008,Initech,0.01
```

Write `/workspace/customer-totals.csv` with the header `customer,total` and one
row per customer: the sum of their amounts with two decimals, the largest
total first.
